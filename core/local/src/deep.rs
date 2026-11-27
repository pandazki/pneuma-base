//! A directory's deep token, for a `look` with `deep`: the states of every file the content rule
//! counts under the directory (size, modification and change times, inode), taken without
//! reading any content, hashed with their paths. Of the bytes only the rule's ignore files are read.

use std::os::fd::RawFd;

use pneuma_base_storage::{Ctx, DeepLook, DeepToken, Failure, Place, Time};
use sha2::{Digest, Sha256};

use crate::LocalFolder;
use crate::fingerprint::{dup, hex};
use crate::noise::Noise;
use crate::rule::{self, Found, Matcher, Side, Walked};

/// The deep token of `files`, given in the byte order of their paths: the SHA-256 of
/// `<path>\0s=<size>;m=<mtime ns>;c=<ctime ns>;i=<inode>\n` for each.
pub fn token_of(files: &[Found], racy: bool) -> DeepToken {
    let mut hasher = Sha256::new();
    for file in files {
        hasher.update(file.path.as_bytes());
        hasher.update([0]);
        let state: Vec<String> = file
            .stat
            .components()
            .iter()
            .map(|(key, value)| format!("{key}={value}"))
            .collect();
        hasher.update(state.join(";").as_bytes());
        hasher.update(b"\n");
    }
    DeepToken::build(files.len() as u64, &hex(&hasher.finalize()), racy)
}

impl LocalFolder {
    /// The deep token of the directory open at `dir`, which is `place` in this view. When a state
    /// was taken within the file system's racy window of its change, the walk is taken again once
    /// that window is past, if it is at most 25 ms away; a state that still cannot vouch for
    /// itself makes the token racy.
    pub fn deep_token(
        &self,
        dir: RawFd,
        place: &Place,
        deep: &DeepLook,
        noise: &Noise,
        ctx: &Ctx,
    ) -> Result<DeepToken, Failure> {
        let sides = [Side {
            noise,
            base: place.clone(),
            hidden: self.hidden(),
        }];
        let matcher = Matcher::new(&sides, &deep.rule);
        let walk = || -> Result<(Time, Walked), Failure> {
            let started = Time::now();
            Ok((started, rule::walk(dup(dir)?, &matcher, deep.limit, ctx)?))
        };
        let (mut started, mut walked) = walk()?;
        if let Some(change) = self.racy_change(started, &walked.files)
            && self.wait_past(change)
        {
            (started, walked) = walk()?;
        }
        let racy = self.racy_change(started, &walked.files).is_some();
        Ok(token_of(&walked.files, racy))
    }

    /// The latest change among `files`, when a state taken from `started` on cannot vouch for it.
    /// Every state of a walk was taken at or after its start, so judging from the start never
    /// trusts a state the moment it was taken could not.
    fn racy_change(&self, started: Time, files: &[Found]) -> Option<i128> {
        files
            .iter()
            .map(|file| file.stat.last_change_ns())
            .max()
            .filter(|&change| started.nanos() - change < self.racy_ns)
    }
}
