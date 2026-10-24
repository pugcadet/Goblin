use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Msg(String),
    #[error("Could not reach the internet: {0}")]
    Network(String),
    #[error("File problem: {0}")]
    Io(#[from] std::io::Error),
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    pub fn msg(text: impl Into<String>) -> Self {
        Error::Msg(text.into())
    }
}
