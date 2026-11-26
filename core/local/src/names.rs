//! One directory level's sorted names, and their copy in the cache area keyed by the
//! directory's token, so a large directory is read whole only once per change.

use std::os::fd::RawFd;

use pneuma_base_storage::{Failure, Place, Time};

use crate::noise::Noise;
use crate::sys::{self, DirStream, Stat};
use crate::{LocalFolder, fnv64};

/// Directories with at least this many entries keep their sorted names in the cache area.
const CACHE_FROM: usize = 1_000;
/// A directory changed this recently may change again within the same clock tick without its
/// token moving, so its names are not cached yet.
const SETTLED_NS: i128 = 2_000_000_000;
const MAGIC: &[u8; 8] = b"PBNAMES1";

/// Sorted names in one buffer; `ends[i]` is where name `i` ends.
pub struct Names {
    blob: Vec<u8>,
    ends: Vec<u32>,
}

impl Names {
    fn from_sorted(names: &[String]) -> Names {
        let mut blob = Vec::with_capacity(names.iter().map(String::len).sum());
        let mut ends = Vec::with_capacity(names.len());
        for name in names {
            blob.extend_from_slice(name.as_bytes());
            ends.push(blob.len() as u32);
        }
        Names { blob, ends }
    }

    pub fn len(&self) -> usize {
        self.ends.len()
    }

    pub fn get(&self, index: usize) -> &str {
        let start = if index == 0 {
            0
        } else {
            self.ends[index - 1] as usize
        };
        std::str::from_utf8(&self.blob[start..self.ends[index] as usize]).unwrap_or_default()
    }

    /// The index of the first name after `after`.
    pub fn first_after(&self, after: &str) -> usize {
        let (mut low, mut high) = (0, self.len());
        while low < high {
            let mid = (low + high) / 2;
            if self.get(mid).as_bytes() <= after.as_bytes() {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        low
    }

    fn encode(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&(self.ends.len() as u32).to_le_bytes());
        for end in &self.ends {
            out.extend_from_slice(&end.to_le_bytes());
        }
        out.extend_from_slice(&self.blob);
    }

    fn decode(input: &mut Reader) -> Option<Names> {
        let count = input.u32()? as usize;
        let ends = (0..count)
            .map(|_| input.u32())
            .collect::<Option<Vec<_>>>()?;
        let total = ends.last().copied().unwrap_or(0) as usize;
        if ends.windows(2).any(|w| w[0] > w[1]) {
            return None;
        }
        let blob = input.bytes(total)?.to_vec();
        std::str::from_utf8(&blob).ok()?;
        Some(Names { blob, ends })
    }
}

/// A directory level without its noise: the names to list and the noise names left out.
pub struct Listing {
    pub names: Names,
    pub noise: Vec<String>,
}

struct Reader<'a>(&'a [u8]);

impl<'a> Reader<'a> {
    fn bytes(&mut self, n: usize) -> Option<&'a [u8]> {
        let (head, rest) = self.0.split_at_checked(n)?;
        self.0 = rest;
        Some(head)
    }

    fn u32(&mut self) -> Option<u32> {
        Some(u32::from_le_bytes(self.bytes(4)?.try_into().ok()?))
    }

    fn u64(&mut self) -> Option<u64> {
        Some(u64::from_le_bytes(self.bytes(8)?.try_into().ok()?))
    }

    fn text(&mut self) -> Option<&'a [u8]> {
        let n = self.u32()? as usize;
        self.bytes(n)
    }
}

fn push_text(out: &mut Vec<u8>, text: &str) {
    out.extend_from_slice(&(text.len() as u32).to_le_bytes());
    out.extend_from_slice(text.as_bytes());
}

fn encode(place: &Place, token: &str, noise_key: u64, listing: &Listing) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&noise_key.to_le_bytes());
    push_text(&mut out, place.as_str());
    push_text(&mut out, token);
    listing.names.encode(&mut out);
    Names::from_sorted(&listing.noise).encode(&mut out);
    out
}

fn decode(bytes: &[u8], place: &Place, token: &str, noise_key: u64) -> Option<Listing> {
    let mut input = Reader(bytes);
    if input.bytes(8)? != MAGIC
        || input.u64()? != noise_key
        || input.text()? != place.as_str().as_bytes()
        || input.text()? != token.as_bytes()
    {
        return None;
    }
    let names = Names::decode(&mut input)?;
    let noise = Names::decode(&mut input)?;
    let noise = (0..noise.len()).map(|i| noise.get(i).to_owned()).collect();
    Some(Listing { names, noise })
}

impl LocalFolder {
    /// The level of the directory open at `dir`, whose state before listing was `stat`.
    pub fn listing(
        &self,
        place: &Place,
        dir: RawFd,
        stat: &Stat,
        noise: &Noise,
    ) -> Result<Listing, Failure> {
        let token = stat.token();
        let noise_key = noise.fingerprint();
        let cache_dir = self.cache_area().join("names");
        // A record place's own area keys its places apart from the content's.
        let key = match &self.records {
            None => place.as_str().to_owned(),
            Some(records) => format!("{}\0{}", records.as_str(), place.as_str()),
        };
        let cache_file = self
            .has_record_area()
            .then(|| cache_dir.join(format!("{:016x}", fnv64(key.as_bytes()))));
        if let Some(path) = &cache_file
            && let Ok(bytes) = std::fs::read(path)
            && let Some(listing) = decode(&bytes, place, token.as_str(), noise_key)
        {
            return Ok(listing);
        }
        let (listing, entries) = read_level(place, dir, noise, self.hidden())?;
        let settled = stat.mtime_ns <= Time::now().nanos() - SETTLED_NS;
        let unchanged = || sys::stat_fd(dir).is_ok_and(|after| after.token() == token);
        if let Some(path) = cache_file
            && entries >= CACHE_FROM
            && settled
            && unchanged()
            && std::fs::create_dir_all(&cache_dir).is_ok()
        {
            // A cache that fails to write only costs time on the next look.
            let _ = crate::write_atomic(&path, &encode(place, token.as_str(), noise_key, &listing));
        }
        Ok(listing)
    }
}

/// Reads every name of the level. Names that are not UTF-8 cannot be named as places and are
/// left out.
fn read_level(
    place: &Place,
    dir: RawFd,
    noise: &Noise,
    hidden: &str,
) -> Result<(Listing, usize), Failure> {
    let unreadable = |errno| Failure::unreadable(sys::errno_name(errno));
    let mut stream = DirStream::open(&dir).map_err(unreadable)?;
    let (mut names, mut noisy, mut entries) = (Vec::new(), Vec::new(), 0);
    while let Some(entry) = stream.next_entry() {
        let (name, _) = entry.map_err(unreadable)?;
        entries += 1;
        let Ok(name) = std::str::from_utf8(name) else {
            continue;
        };
        if place.is_root() && name == hidden {
            continue;
        }
        if noise.is_noise_entry(place, name) {
            noisy.push(name.to_owned());
        } else {
            names.push(name.to_owned());
        }
    }
    names.sort_unstable();
    noisy.sort_unstable();
    let listing = Listing {
        names: Names::from_sorted(&names),
        noise: noisy,
    };
    Ok((listing, entries))
}
