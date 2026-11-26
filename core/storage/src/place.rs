use serde::{Serialize, Serializer};

/// A point in the content half: a relative `/`-separated path. `""` is the root.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Place(String);

impl Place {
    pub fn parse(text: &str) -> Option<Place> {
        if text.is_empty() {
            return Some(Place(String::new()));
        }
        let valid = !text.contains('\0')
            && text
                .split('/')
                .all(|segment| !segment.is_empty() && segment != "." && segment != "..");
        valid.then(|| Place(text.to_owned()))
    }

    pub fn root() -> Place {
        Place(String::new())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn is_root(&self) -> bool {
        self.0.is_empty()
    }

    /// The segments, none for the root.
    pub fn segments(&self) -> Vec<&str> {
        if self.0.is_empty() {
            Vec::new()
        } else {
            self.0.split('/').collect()
        }
    }

    /// `name` must itself be a valid segment.
    pub fn child(&self, name: &str) -> Place {
        if self.0.is_empty() {
            Place(name.to_owned())
        } else {
            Place(format!("{}/{}", self.0, name))
        }
    }

    pub fn is_at_or_under(&self, other: &Place) -> bool {
        other.is_root()
            || self.0 == other.0
            || (self.0.len() > other.0.len()
                && self.0.starts_with(&other.0)
                && self.0.as_bytes()[other.0.len()] == b'/')
    }
}

impl Serialize for Place {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

/// A place as the caller asked for it in a list: either valid, or kept verbatim so the answer
/// can name it next to its `bad_request`.
#[derive(Clone, Debug)]
pub enum PlaceArg {
    Valid(Place),
    Malformed(String),
}

impl PlaceArg {
    pub fn parse(text: &str) -> PlaceArg {
        match Place::parse(text) {
            Some(place) => PlaceArg::Valid(place),
            None => PlaceArg::Malformed(text.to_owned()),
        }
    }

    pub fn text(&self) -> &str {
        match self {
            PlaceArg::Valid(place) => place.as_str(),
            PlaceArg::Malformed(text) => text,
        }
    }
}

/// The names the storage keeps for its own directories in the record half. A record place with
/// one of them would put its facts and content among the storage's caches, holds and leftovers.
pub const STORAGE_NAMES: [&str; 4] = ["cache", "holds", "tmp", "trash"];

/// A namespace in the record half, named by the kernel: `[a-z0-9][a-z0-9-]*`, none of the
/// storage's own names.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecordPlace(String);

impl RecordPlace {
    pub fn parse(text: &str) -> Option<RecordPlace> {
        let mut bytes = text.bytes();
        let first_ok = bytes
            .next()
            .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
        let rest_ok = bytes.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
        (first_ok && rest_ok && !STORAGE_NAMES.contains(&text))
            .then(|| RecordPlace(text.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Where a content operation's places are: the content, or a record place's own area.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Area {
    Content,
    Records(RecordPlace),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn places_reject_dots_empties_and_absolutes() {
        for bad in ["/a", "a/", "a//b", ".", "a/./b", "..", "a/../b", "a\0b"] {
            assert!(Place::parse(bad).is_none(), "{bad:?}");
        }
        for good in ["", "a", "a/b.c", ".hidden/x", "a/..b"] {
            assert!(Place::parse(good).is_some(), "{good:?}");
        }
    }

    #[test]
    fn under_means_a_whole_segment_prefix() {
        let p = |s| Place::parse(s).unwrap();
        assert!(p("a/b").is_at_or_under(&p("a")));
        assert!(p("a").is_at_or_under(&p("a")));
        assert!(!p("ab").is_at_or_under(&p("a")));
        assert!(p("x").is_at_or_under(&Place::root()));
    }

    #[test]
    fn record_places_follow_the_pattern() {
        assert!(RecordPlace::parse("scenes-2").is_some());
        for bad in [
            "", "-a", "A", "a_b", "a/b", "cache", "holds", "tmp", "trash",
        ] {
            assert!(RecordPlace::parse(bad).is_none(), "{bad:?}");
        }
    }
}
