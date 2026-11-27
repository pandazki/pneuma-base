//! What the local folder says about a place, by source. Each source gives one facet, and may give
//! components of the state token; a place's description and token are composed from all of them.
//! Adding a source (a sync service, git) is one more entry in `SOURCES`; nothing else changes.

use std::ffi::CString;
use std::os::unix::ffi::OsStrExt;

use pneuma_base_storage::{Description, Facets, Kind, Place, Time, Token};
use serde_json::{Map, Value, json};

use crate::LocalFolder;
use crate::sys::Stat;

/// One place as the sources see it.
pub struct At<'a> {
    pub folder: &'a LocalFolder,
    pub place: &'a Place,
    pub stat: &'a Stat,
}

impl At<'_> {
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    fn c_path(&self) -> CString {
        crate::sys::c_name(self.folder.path_of(self.place).as_os_str().as_bytes())
    }
}

pub trait Source: Sync {
    fn name(&self) -> &'static str;

    /// Whether this platform can give the facet at all.
    fn available(&self) -> bool {
        true
    }

    /// A costlier facet comes only when asked for by name.
    fn on_request(&self) -> bool {
        false
    }

    /// The components this source adds to the token. They must not depend on which facets were
    /// asked for.
    fn components(&self, _at: &At, _out: &mut Vec<(&'static str, String)>) {}

    /// `wanted` is the facets asked for, which may name a field given only on request as
    /// `<facet>.<field>`.
    fn facet(&self, at: &At, wanted: &[String]) -> Option<Value>;
}

pub const SOURCES: [&dyn Source; 3] = [&FsSource, &MacosSource, &PlaceholderSource];

/// The facet names this platform can give, for `describe`.
pub fn available() -> Vec<&'static str> {
    SOURCES
        .iter()
        .filter(|s| s.available())
        .map(|s| s.name())
        .collect()
}

/// A place's description from its metadata. `count` is a directory's entry count when known;
/// `fingerprint` is the content's, when the caller just read or wrote it.
pub fn describe(
    at: &At,
    count: Option<u64>,
    wanted: &[String],
    fingerprint: Option<&str>,
) -> Description {
    let mut facets = Facets::default();
    for source in SOURCES {
        if !source.available()
            || (source.on_request() && !wanted.iter().any(|w| w == source.name()))
        {
            continue;
        }
        if let Some(facet) = source.facet(at, wanted) {
            facets.push(source.name(), facet);
        }
    }
    let size = match at.stat.kind {
        Kind::File => Some(at.stat.size),
        Kind::Dir => count,
        Kind::Other => None,
    };
    Description {
        place: at.place.clone(),
        kind: at.stat.kind,
        token: token(at, fingerprint),
        size,
        modified: at.stat.modified(),
        facets,
        held: false,
    }
}

/// The composed token. A place whose state changed too recently for the file system's clock to
/// tell a second change from the first is racy: its token says so, with the content's fingerprint
/// when known, so the next comparison confirms by reading instead of trusting the components.
pub fn token(at: &At, fingerprint: Option<&str>) -> Token {
    let mut components = Vec::new();
    for source in SOURCES {
        source.components(at, &mut components);
    }
    let racy = at.folder.is_racy(at.stat, Time::now());
    let annotation = match (racy, fingerprint) {
        (false, _) => None,
        (true, Some(fingerprint)) if at.stat.kind == Kind::File => {
            Some(("h", fingerprint.to_owned()))
        }
        (true, _) => Some(("r", String::new())),
    };
    Token::build(components, annotation)
}

struct FsSource;

impl Source for FsSource {
    fn name(&self) -> &'static str {
        "fs"
    }

    fn components(&self, at: &At, out: &mut Vec<(&'static str, String)>) {
        out.extend(at.stat.components());
    }

    fn facet(&self, at: &At, wanted: &[String]) -> Option<Value> {
        let mut facet = json!({
            "inode": at.stat.inode,
            "device": at.stat.device,
            "created": at.stat.created(),
            "mode": at.stat.mode,
        });
        if wanted.iter().any(|w| w == "fs.path")
            && let Some(path) = at.folder.path_of(at.place).to_str()
        {
            facet["path"] = json!(path);
        }
        Some(facet)
    }
}

/// Where a file was downloaded from, which program brought it in, and its Finder tags: extended
/// attributes, read only when asked for.
struct MacosSource;

impl Source for MacosSource {
    fn name(&self) -> &'static str {
        "macos"
    }

    fn available(&self) -> bool {
        cfg!(target_os = "macos")
    }

    fn on_request(&self) -> bool {
        true
    }

    #[cfg(target_os = "macos")]
    fn facet(&self, at: &At, _wanted: &[String]) -> Option<Value> {
        let path = at.c_path();
        let names = crate::sys::xattr_names(&path);
        let has = |name: &str| names.iter().any(|n| n == name.as_bytes());
        let read = |name: &str| crate::sys::xattr(&path, &crate::sys::c_name(name.as_bytes()));
        let mut facet = Map::new();
        if has(WHERE_FROMS)
            && let Some(urls) = read(WHERE_FROMS).and_then(|b| bplist::strings(&b))
        {
            facet.insert("where_from".into(), json!(urls));
        }
        if has(QUARANTINE)
            && let Some(agent) = read(QUARANTINE).and_then(|b| quarantine_agent(&b))
        {
            facet.insert("quarantine".into(), json!(agent));
        }
        if has(TAGS)
            && let Some(tags) = read(TAGS).and_then(|b| bplist::strings(&b))
        {
            let tags: Vec<String> = tags.into_iter().map(|t| tag_name(&t)).collect();
            facet.insert("tags".into(), json!(tags));
        }
        (!facet.is_empty()).then_some(Value::Object(facet))
    }

    #[cfg(not(target_os = "macos"))]
    fn facet(&self, _at: &At, _wanted: &[String]) -> Option<Value> {
        None
    }
}

#[cfg(target_os = "macos")]
const WHERE_FROMS: &str = "com.apple.metadata:kMDItemWhereFroms";
#[cfg(target_os = "macos")]
const QUARANTINE: &str = "com.apple.quarantine";
#[cfg(target_os = "macos")]
const TAGS: &str = "com.apple.metadata:_kMDItemUserTags";

/// `flags;hex time;agent;uuid`: the agent is the program that brought the file in.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn quarantine_agent(bytes: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(bytes).ok()?;
    let agent = text.split(';').nth(2)?.trim();
    (!agent.is_empty()).then(|| agent.to_owned())
}

/// A Finder tag is stored as `name\n<colour number>`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn tag_name(stored: &str) -> String {
    match stored.rsplit_once('\n') {
        Some((name, colour)) if colour.bytes().all(|b| b.is_ascii_digit()) => name.to_owned(),
        _ => stored.to_owned(),
    }
}

/// A sync service keeps only a placeholder here: the content is elsewhere.
struct PlaceholderSource;

impl Source for PlaceholderSource {
    fn name(&self) -> &'static str {
        "placeholder"
    }

    fn available(&self) -> bool {
        cfg!(target_os = "macos")
    }

    fn facet(&self, at: &At, _wanted: &[String]) -> Option<Value> {
        if !at.stat.dataless() {
            return None;
        }
        let mut facet = Map::new();
        if let Some(provider) = provider_of(&at.folder.path_of(at.place)) {
            facet.insert("provider".into(), json!(provider));
        }
        facet.insert("size_elsewhere".into(), json!(at.stat.size));
        Some(Value::Object(facet))
    }
}

/// The sync service a path lies under, from where macOS puts their folders.
pub fn provider_of(path: &std::path::Path) -> Option<String> {
    let text = path.to_str()?;
    if text.contains("/Library/Mobile Documents/") {
        return Some("icloud".to_owned());
    }
    let (_, rest) = text.split_once("/Library/CloudStorage/")?;
    let folder = rest.split('/').next()?;
    let name = folder.split('-').next()?.to_ascii_lowercase();
    (!name.is_empty()).then_some(name)
}

/// Just enough of Apple's binary property lists to read an array of strings.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
mod bplist {
    pub fn strings(bytes: &[u8]) -> Option<Vec<String>> {
        let list = Plist::parse(bytes)?;
        let top = list.object(list.top)?;
        let (marker, mut at) = (top.0, top.1);
        if marker >> 4 != 0xA {
            return None;
        }
        let count = list.length(marker, &mut at)?;
        (0..count)
            .map(|i| {
                let reference = list.int(at + i * list.ref_size, list.ref_size)?;
                list.string(reference)
            })
            .collect()
    }

    struct Plist<'a> {
        bytes: &'a [u8],
        offset_size: usize,
        ref_size: usize,
        objects: usize,
        top: usize,
        table: usize,
    }

    impl<'a> Plist<'a> {
        fn parse(bytes: &'a [u8]) -> Option<Plist<'a>> {
            if bytes.len() < 40 || !bytes.starts_with(b"bplist00") {
                return None;
            }
            let trailer = &bytes[bytes.len() - 32..];
            let n = |range: std::ops::Range<usize>| {
                trailer[range]
                    .iter()
                    .fold(0usize, |n, b| n << 8 | usize::from(*b))
            };
            Some(Plist {
                bytes,
                offset_size: usize::from(trailer[6]),
                ref_size: usize::from(trailer[7]),
                objects: n(8..16),
                top: n(16..24),
                table: n(24..32),
            })
        }

        fn int(&self, at: usize, size: usize) -> Option<usize> {
            let bytes = self.bytes.get(at..at.checked_add(size)?)?;
            Some(bytes.iter().fold(0usize, |n, b| n << 8 | usize::from(*b)))
        }

        /// The marker byte of object `index` and where its body starts.
        fn object(&self, index: usize) -> Option<(u8, usize)> {
            if index >= self.objects {
                return None;
            }
            let offset = self.int(self.table + index * self.offset_size, self.offset_size)?;
            Some((*self.bytes.get(offset)?, offset + 1))
        }

        /// The element count in the low nibble, or in the integer that follows when it is 0xF.
        fn length(&self, marker: u8, at: &mut usize) -> Option<usize> {
            let low = marker & 0xF;
            if low != 0xF {
                return Some(usize::from(low));
            }
            let int_marker = *self.bytes.get(*at)?;
            if int_marker >> 4 != 0x1 {
                return None;
            }
            let size = 1usize << (int_marker & 0xF);
            let n = self.int(*at + 1, size)?;
            *at += 1 + size;
            Some(n)
        }

        fn string(&self, index: usize) -> Option<String> {
            let (marker, mut at) = self.object(index)?;
            let count = self.length(marker, &mut at)?;
            match marker >> 4 {
                0x5 => {
                    let bytes = self.bytes.get(at..at + count)?;
                    Some(bytes.iter().map(|b| char::from(*b)).collect())
                }
                0x6 => {
                    let bytes = self.bytes.get(at..at + count * 2)?;
                    let units: Vec<u16> = bytes
                        .chunks(2)
                        .map(|c| u16::from_be_bytes([c[0], c[1]]))
                        .collect();
                    String::from_utf16(&units).ok()
                }
                _ => None,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A binary property list holding an array of ASCII strings, as Finder and browsers write.
    pub fn bplist_of(strings: &[&str]) -> Vec<u8> {
        let mut out = b"bplist00".to_vec();
        let mut offsets = Vec::new();
        offsets.push(out.len());
        out.push(0xA0 | strings.len() as u8);
        for i in 0..strings.len() {
            out.push(i as u8 + 1);
        }
        for s in strings {
            offsets.push(out.len());
            if s.len() < 15 {
                out.push(0x50 | s.len() as u8);
            } else {
                out.extend([0x5F, 0x10, s.len() as u8]);
            }
            out.extend(s.as_bytes());
        }
        let table = out.len();
        for offset in &offsets {
            out.push(*offset as u8);
        }
        out.extend([0, 0, 0, 0, 0, 0, 1, 1]);
        out.extend((offsets.len() as u64).to_be_bytes());
        out.extend(0u64.to_be_bytes());
        out.extend((table as u64).to_be_bytes());
        out
    }

    #[test]
    fn reads_an_array_of_strings() {
        let bytes = bplist_of(&["https://example.com/file.zip", "https://example.com/"]);
        assert_eq!(
            bplist::strings(&bytes),
            Some(vec![
                "https://example.com/file.zip".to_owned(),
                "https://example.com/".to_owned()
            ])
        );
        assert_eq!(
            bplist::strings(b"not a plist at all, long enough to try"),
            None
        );
    }

    #[test]
    fn tags_and_quarantine_read_as_names() {
        assert_eq!(tag_name("Work\n4"), "Work");
        assert_eq!(tag_name("Plain"), "Plain");
        assert_eq!(
            quarantine_agent(b"0083;6aee14ed;Safari;0A1B2C3D-0000-0000-0000-000000000000"),
            Some("Safari".to_owned())
        );
        assert_eq!(quarantine_agent(b"0083;6aee14ed;;"), None);
    }

    #[test]
    fn providers_are_named_by_their_folders() {
        let p = |s: &str| provider_of(std::path::Path::new(s));
        assert_eq!(
            p("/Users/x/Library/Mobile Documents/com~apple~CloudDocs/a"),
            Some("icloud".into())
        );
        assert_eq!(
            p("/Users/x/Library/CloudStorage/Dropbox/lib/a"),
            Some("dropbox".into())
        );
        assert_eq!(
            p("/Users/x/Library/CloudStorage/GoogleDrive-x@example.com/My Drive/a"),
            Some("googledrive".into())
        );
        assert_eq!(p("/Users/x/notes/a"), None);
    }
}
