use serde::Serialize;

/// The storage's opaque mark of a place's state: `v1;<key>=<value>;…`, one component per source.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct Token(String);

impl Token {
    pub fn new(text: String) -> Token {
        Token(text)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// `None` when the text is not a version-1 token with at least one component.
    pub fn components(&self) -> Option<Vec<(&str, &str)>> {
        let mut parts = self.0.split(';');
        if parts.next() != Some("v1") {
            return None;
        }
        let components: Option<Vec<_>> = parts
            .map(|part| part.split_once('=').filter(|(key, _)| !key.is_empty()))
            .collect();
        components.filter(|list| !list.is_empty())
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
}
