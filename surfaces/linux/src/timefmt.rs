#![forbid(unsafe_code)]

//! 时间与数字的写法：阿拉伯数字、固定格式，与 Web 治理面的 `ui/format.ts` 同构。

use gtk::glib;
use gtk4 as gtk;

const MINUTE_MS: u64 = 60_000;
const HOUR_MS: u64 = 60 * MINUTE_MS;
const DAY_SECS: i64 = 86_400;

fn local(ms: u64) -> Option<glib::DateTime> {
    let secs = i64::try_from(ms / 1000).ok()?;
    glib::DateTime::from_unix_local(secs).ok()
}

/// 当前时刻（毫秒时间戳）。
#[must_use]
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

fn start_of_day_secs(ms: u64) -> i64 {
    let Some(date) = local(ms) else {
        return i64::try_from(ms / 1000).unwrap_or(0);
    };
    glib::DateTime::from_local(date.year(), date.month(), date.day_of_month(), 0, 0, 0.0)
        .map_or(date.to_unix(), |midnight| midnight.to_unix())
}

/// 两个时刻之间隔了多少个日历日（同一天为 0）。
#[must_use]
pub fn calendar_days_between(from_ms: u64, to_ms: u64) -> i64 {
    let delta = start_of_day_secs(to_ms) - start_of_day_secs(from_ms);
    // 夏令时让一天不是 86400 秒：四舍五入到整天。
    (delta + DAY_SECS / 2).div_euclid(DAY_SECS)
}

fn pattern(ms: u64, format: &str) -> String {
    local(ms)
        .and_then(|date| date.format(format).ok())
        .map(|text| text.to_string())
        .unwrap_or_default()
}

/// `2026-11-28`
#[must_use]
pub fn format_date(ms: u64) -> String {
    pattern(ms, "%Y-%m-%d")
}

/// `09:14`
#[must_use]
pub fn format_clock(ms: u64) -> String {
    pattern(ms, "%H:%M")
}

/// `2026-11-28 09:14`
#[must_use]
pub fn format_date_time(ms: u64) -> String {
    pattern(ms, "%Y-%m-%d %H:%M")
}

/// 「相处第 N 天」里的 N：认识的当天是第 1 天。
#[must_use]
pub fn days_together(since_ms: u64, now: u64) -> i64 {
    (calendar_days_between(since_ms, now) + 1).max(1)
}

/// 离现在多久：刚刚、几分钟前、几小时前、昨天、几天前；再远就写日期。
#[must_use]
pub fn format_ago(ms: u64, now: u64) -> String {
    let elapsed = now.saturating_sub(ms);
    if elapsed < MINUTE_MS {
        return String::from("刚刚");
    }
    if elapsed < HOUR_MS {
        return format!("{} 分钟前", elapsed / MINUTE_MS);
    }
    let days = calendar_days_between(ms, now);
    if days <= 0 {
        return format!("{} 小时前", elapsed / HOUR_MS);
    }
    if days == 1 {
        return String::from("昨天");
    }
    if days <= 30 {
        return format!("{days} 天前");
    }
    format_date(ms)
}

/// 时间线里一天的标题：`11 月 28 日 · 今天`。
#[must_use]
pub fn format_day_heading(ms: u64, now: u64) -> String {
    let same_year = pattern(ms, "%Y") == pattern(now, "%Y");
    let base = if same_year {
        pattern(ms, "%-m 月 %-d 日")
    } else {
        pattern(ms, "%Y 年 %-m 月 %-d 日")
    };
    match calendar_days_between(ms, now) {
        0 => format!("{base} · 今天"),
        1 => format!("{base} · 昨天"),
        _ => base,
    }
}

/// 一组时刻跨了多少天（同一天算 1 天；空组为 0）。
#[must_use]
pub fn span_days(times: &[u64]) -> i64 {
    let (Some(min), Some(max)) = (times.iter().min(), times.iter().max()) else {
        return 0;
    };
    calendar_days_between(*min, *max) + 1
}

/// 等宽两位编号：`01`、`02`。
#[must_use]
pub fn ordinal(index: usize) -> String {
    format!("{:02}", index + 1)
}

/// 列表里的一行摘要；全文在选中之后看。
#[must_use]
pub fn excerpt(text: &str, max: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let chars: Vec<char> = flat.chars().collect();
    if chars.len() <= max {
        flat
    } else {
        format!("{}…", chars[..max].iter().collect::<String>())
    }
}

/// 0–1 的权重写成 0–100 的整数。
#[must_use]
pub fn percent(weight: f64) -> u32 {
    let clamped = if weight.is_nan() {
        0.0
    } else {
        weight.clamp(0.0, 1.0)
    };
    // 取值已夹在 0..=100 之内，转换不会截断。
    (clamped * 100.0).round() as u32
}

/// 同步服务的地址只留主机部分。
#[must_use]
pub fn hub_host(url: &str) -> String {
    let rest = url.split("://").nth(1).unwrap_or(url);
    rest.split('/').next().unwrap_or(rest).to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn excerpt_cuts_on_chars_not_bytes() {
        assert_eq!(excerpt("你好，世界", 3), "你好，…");
        assert_eq!(excerpt("  a \n b ", 10), "a b");
    }

    #[test]
    fn percent_is_clamped() {
        assert_eq!(percent(0.256), 26);
        assert_eq!(percent(-1.0), 0);
        assert_eq!(percent(7.0), 100);
        assert_eq!(percent(f64::NAN), 0);
    }

    #[test]
    fn ordinal_is_two_digits() {
        assert_eq!(ordinal(0), "01");
        assert_eq!(ordinal(11), "12");
    }

    #[test]
    fn hub_host_keeps_only_the_host() {
        assert_eq!(
            hub_host("https://hub.example.test:443/relay"),
            "hub.example.test:443"
        );
        assert_eq!(hub_host("hub.example.test"), "hub.example.test");
    }

    #[test]
    fn same_day_is_zero_days_apart_and_first_day_together() {
        let now = 1_795_000_000_000;
        assert_eq!(calendar_days_between(now, now + 60_000), 0);
        assert_eq!(days_together(now, now), 1);
        assert_eq!(format_ago(now, now + 30_000), "刚刚");
        assert_eq!(format_ago(now, now + 5 * MINUTE_MS), "5 分钟前");
    }
}
