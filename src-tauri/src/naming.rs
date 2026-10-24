//! File-name clean-up (the same rules as Media Hub's naming.rs).

/// "name.ext" -> ("name", "ext"); no extension -> (name, "").
pub fn split_ext(name: &str) -> (&str, &str) {
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && !ext.is_empty() && ext.len() <= 5 => (stem, ext),
        _ => (name, ""),
    }
}

/// Makes text safe as one file or folder name on Mac, Windows and NAS shares.
pub fn sanitize(s: &str) -> String {
    let s = s.replace(": ", " - ");
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            ':' | '/' | '\\' => out.push('-'),
            '"' | '*' | '?' | '<' | '>' | '|' => {}
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    finalize_component(&out)
}

const RESERVED: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// Final tidy of one path component: single spaces, no trailing dots/spaces, not too long.
pub fn finalize_component(c: &str) -> String {
    let collapsed = c.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut t = collapsed.trim_end_matches(['.', ' ']).to_string();
    if RESERVED.contains(&split_ext(&t).0.to_lowercase().as_str()) {
        t.insert(0, '_');
    }
    const MAX: usize = 200;
    if t.chars().count() > MAX {
        let (stem, ext) = split_ext(&t);
        let keep = MAX.saturating_sub(ext.chars().count() + 1);
        let short: String = stem.chars().take(keep).collect();
        t = if ext.is_empty() { short } else { format!("{short}.{ext}") };
    }
    t
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleans_names() {
        assert_eq!(sanitize("AC/DC: Live?"), "AC-DC - Live");
        assert_eq!(sanitize("con"), "_con");
        assert_eq!(sanitize("  spaced   out.  "), "spaced out");
    }
}
