use serde::{Serialize, Serializer};

/// A moment, nanoseconds since the Unix epoch; on the wire ISO 8601 UTC with milliseconds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Time(i128);

impl Time {
    pub fn from_nanos(ns: i128) -> Time {
        Time(ns)
    }

    pub fn from_millis(ms: i64) -> Time {
        Time(i128::from(ms) * 1_000_000)
    }

    pub fn now() -> Time {
        let since = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default();
        Time(since.as_nanos() as i128)
    }

    pub fn nanos(self) -> i128 {
        self.0
    }

    pub fn millis(self) -> i64 {
        self.0.div_euclid(1_000_000) as i64
    }

    pub fn iso(self) -> String {
        let p = self.parts();
        format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
            p.year, p.month, p.day, p.hour, p.minute, p.second, p.milli
        )
    }

    /// `YYYY-MM-DD`, the name of the day's directory in the dated facts layout.
    pub fn day(self) -> String {
        let p = self.parts();
        format!("{:04}-{:02}-{:02}", p.year, p.month, p.day)
    }

    /// `yyyymmddHHMMSSmmm`, the time prefix of a facts file's name.
    pub fn stamp(self) -> String {
        let p = self.parts();
        format!(
            "{:04}{:02}{:02}{:02}{:02}{:02}{:03}",
            p.year, p.month, p.day, p.hour, p.minute, p.second, p.milli
        )
    }

    /// Reads the 17-digit stamp at the start of a name.
    pub fn parse_stamp(name: &str) -> Option<Time> {
        let digits = name.get(..17)?;
        if !digits.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let n = |range: std::ops::Range<usize>| digits[range].parse::<i64>().ok();
        let (year, month, day) = (n(0..4)?, n(4..6)?, n(6..8)?);
        let (hour, minute, second, milli) = (n(8..10)?, n(10..12)?, n(12..14)?, n(14..17)?);
        if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 {
            return None;
        }
        let days = days_from_civil(year, month as u32, day as u32);
        let secs = days * 86_400 + hour * 3_600 + minute * 60 + second;
        Some(Time::from_millis(secs * 1_000 + milli))
    }

    fn parts(self) -> Parts {
        let ms = self.millis();
        let secs = ms.div_euclid(1_000);
        let (year, month, day) = civil_from_days(secs.div_euclid(86_400));
        let of_day = secs.rem_euclid(86_400);
        Parts {
            year,
            month,
            day,
            hour: of_day / 3_600,
            minute: of_day % 3_600 / 60,
            second: of_day % 60,
            milli: ms.rem_euclid(1_000),
        }
    }
}

impl Serialize for Time {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.iso())
    }
}

struct Parts {
    year: i64,
    month: u32,
    day: u32,
    hour: i64,
    minute: i64,
    second: i64,
    milli: i64,
}

// Howard Hinnant's civil calendar algorithms.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let yoe = year.rem_euclid(400);
    let month = i64::from(month);
    let mp = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * mp + 2) / 5 + i64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_known_moments() {
        assert_eq!(Time::from_millis(0).iso(), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            Time::from_millis(1_795_679_280_123).iso(),
            "2026-11-26T07:48:00.123Z"
        );
        assert_eq!(Time::from_millis(-1).iso(), "1969-12-31T23:59:59.999Z");
        assert_eq!(Time::from_millis(951_782_400_000).day(), "2000-02-29");
    }

    #[test]
    fn stamps_round_trip() {
        let t = Time::from_millis(1_795_679_280_123);
        assert_eq!(t.stamp(), "20261126074800123");
        assert_eq!(
            Time::parse_stamp("20261126074800123-w-000001.jsonl"),
            Some(t)
        );
        assert_eq!(Time::parse_stamp("2026112303480012x"), None);
    }
}
