//! The checks, by the part of `STORAGE.md` they drive. Each is `fn(&Env) -> Outcome`; the
//! registry keys it to the sentences it decides.

pub mod basics;
pub mod changes;
pub mod concurrency;
pub mod failures;
pub mod interruption;
pub mod local;
pub mod others;
pub mod places;
pub mod reads;
pub mod records;
pub mod rules;
pub mod writes;
