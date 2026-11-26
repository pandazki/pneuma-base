use serde::Serialize;

/// The storage's opaque mark of a place's state: `v1;<key>=<value>;…`, one component per source.
///
/// A component whose key starts with `*` identifies content: when it is the same on both sides,
/// the content is the same. A part whose key starts with `!` is an annotation, not a component: it
/// is never compared. `!r` says the token was taken so soon after a change that its components
/// cannot vouch for the state; `!h=<sha256>` says the same and carries the fingerprint of the
/// content the token stands for, so a later comparison can confirm by reading.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct Token(String);

/// What a token says about how far its components can be trusted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Trust<'a> {
    Settled,
    /// Racy, with no fingerprint to confirm against.
    Racy,
    /// Racy, with the fingerprint of the content it stands for.
    RacyWith(&'a str),
}

impl Token {
    pub fn new(text: String) -> Token {
        Token(text)
    }

    /// Builds a token from components and annotations (each `(key, value)`; an empty value writes
    /// the bare key).
    pub fn build<'a>(
        components: impl IntoIterator<Item = (&'a str, String)>,
        annotations: impl IntoIterator<Item = (&'a str, String)>,
    ) -> Token {
        let mut text = String::from("v1");
        for (key, value) in components {
            text.push(';');
            text.push_str(key);
            text.push('=');
            text.push_str(&value);
        }
        for (key, value) in annotations {
            text.push_str(";!");
            text.push_str(key);
            if !value.is_empty() {
                text.push('=');
                text.push_str(&value);
            }
        }
        Token(text)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    fn parts(&self) -> Option<std::str::Split<'_, char>> {
        let mut parts = self.0.split(';');
        (parts.next() == Some("v1")).then_some(parts)
    }

    /// `None` when the text is not a version-1 token with at least one component.
    pub fn components(&self) -> Option<Vec<(&str, &str)>> {
        let mut components = Vec::new();
        for part in self.parts()? {
            if part.starts_with('!') {
                continue;
            }
            let (key, value) = part.split_once('=').filter(|(key, _)| !key.is_empty())?;
            components.push((key, value));
        }
        (!components.is_empty()).then_some(components)
    }

    pub fn trust(&self) -> Trust<'_> {
        let mut trust = Trust::Settled;
        for part in self.parts().into_iter().flatten() {
            match part
                .strip_prefix('!')
                .map(|a| a.split_once('=').unwrap_or((a, "")))
            {
                Some(("h", hash)) if !hash.is_empty() => return Trust::RacyWith(hash),
                Some(("r", _)) => trust = Trust::Racy,
                _ => {}
            }
        }
        trust
    }

    /// The contract's fixed rule: changed when any component present in both differs; a
    /// component present in only one is not compared. Two tokens with no component in common
    /// cannot vouch for each other, so they count as changed. `None` when either is malformed.
    pub fn changed_since(&self, remembered: &Token) -> Option<bool> {
        let now = self.components()?;
        let then = remembered.components()?;
        let mut shared = 0;
        for (key, value) in &now {
            if let Some((_, old)) = then.iter().find(|(k, _)| k == key) {
                if old != value {
                    return Some(true);
                }
                shared += 1;
            }
        }
        Some(shared == 0)
    }

    /// Whether a component marked as identifying content is on both sides and the same on each:
    /// then the content is the same without reading it.
    pub fn same_content(&self, other: &Token) -> bool {
        let (Some(mine), Some(theirs)) = (self.components(), other.components()) else {
            return false;
        };
        let marked: Vec<_> = mine.iter().filter(|(k, _)| k.starts_with('*')).collect();
        !marked.is_empty()
            && marked
                .iter()
                .all(|(key, value)| theirs.iter().any(|(k, v)| k == key && v == value))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(s: &str) -> Token {
        Token::new(s.to_owned())
    }

    #[test]
    fn a_differing_shared_component_is_a_change() {
        assert_eq!(t("v1;s=1;m=2").changed_since(&t("v1;s=1;m=3")), Some(true));
        assert_eq!(t("v1;s=1;m=2").changed_since(&t("v1;s=1;m=2")), Some(false));
    }

    #[test]
    fn a_component_in_one_side_only_is_not_compared() {
        assert_eq!(
            t("v1;s=1;m=2;i=9").changed_since(&t("v1;s=1;m=2")),
            Some(false)
        );
        assert_eq!(t("v1;s=1").changed_since(&t("v1;s=1;x=7")), Some(false));
    }

    #[test]
    fn malformed_tokens_are_not_compared() {
        assert_eq!(t("v1;s=1").changed_since(&t("garbage")), None);
        assert_eq!(t("v1;s=1").changed_since(&t("v1")), None);
        assert_eq!(t("v1;s=1").changed_since(&t("v2;s=1")), None);
    }

    #[test]
    fn annotations_are_never_compared() {
        assert_eq!(t("v1;s=1;!r").changed_since(&t("v1;s=1")), Some(false));
        assert_eq!(
            t("v1;s=1;!h=ab").changed_since(&t("v1;s=1;!h=cd")),
            Some(false)
        );
        assert_eq!(t("v1;!r").components(), None);
        assert_eq!(t("v1;s=1;!r").trust(), Trust::Racy);
        assert_eq!(t("v1;s=1;!h=ab").trust(), Trust::RacyWith("ab"));
        assert_eq!(t("v1;s=1").trust(), Trust::Settled);
    }

    #[test]
    fn marked_components_identify_content() {
        assert!(t("v1;s=1;*git=a").same_content(&t("v1;s=2;*git=a")));
        assert!(!t("v1;s=1;*git=a").same_content(&t("v1;s=1;*git=b")));
        assert!(!t("v1;s=1").same_content(&t("v1;s=1")));
        assert!(!t("v1;s=1;*git=a").same_content(&t("v1;s=1")));
    }

    #[test]
    fn built_tokens_read_back() {
        let token = Token::build([("s", "3".to_owned())], [("h", "ff".to_owned())]);
        assert_eq!(token.as_str(), "v1;s=3;!h=ff");
        assert_eq!(token.components(), Some(vec![("s", "3")]));
        assert_eq!(token.trust(), Trust::RacyWith("ff"));
        assert_eq!(
            Token::build([("s", "3".to_owned())], [("r", String::new())]).as_str(),
            "v1;s=3;!r"
        );
    }
}
