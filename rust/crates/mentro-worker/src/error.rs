use crate::proto::mentro::worker::v1::EErrorCode;

/// Worker error carrying the protocol error code and retry classification.
#[derive(Debug)]
pub struct WorkerError {
    pub code: EErrorCode,
    pub message: String,
    pub retryable: bool,
}

impl WorkerError {
    pub fn new(code: EErrorCode, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code,
            message: message.into(),
            retryable,
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(EErrorCode::InvalidInput, message, false)
    }

    pub fn unsupported(message: impl Into<String>) -> Self {
        Self::new(EErrorCode::Unsupported, message, false)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(EErrorCode::Internal, message, false)
    }
}

impl std::fmt::Display for WorkerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}

impl std::error::Error for WorkerError {}

impl From<anyhow::Error> for WorkerError {
    fn from(err: anyhow::Error) -> Self {
        WorkerError::internal(err.to_string())
    }
}

pub type WorkerResult<T> = Result<T, WorkerError>;
