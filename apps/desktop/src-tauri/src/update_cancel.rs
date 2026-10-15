//! Register cancellation before scheduling blocking work; never reset an active token.
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
type Active = Arc<Mutex<Option<Arc<AtomicBool>>>>;
#[derive(Clone, Default)]
pub struct CancellationSlot(Active);
pub struct Operation {
    slot: Active,
    flag: Arc<AtomicBool>,
}
impl CancellationSlot {
    pub fn begin(&self) -> Result<Operation, String> {
        let mut active = self.0.lock().map_err(|_| "UPDATE_STATE_UNAVAILABLE")?;
        if active.is_some() {
            return Err("OPERATION_BUSY".into());
        }
        let flag = Arc::new(AtomicBool::new(false));
        *active = Some(flag.clone());
        Ok(Operation {
            slot: self.0.clone(),
            flag,
        })
    }
    pub fn cancel(&self) -> Result<(), String> {
        let active = self.0.lock().map_err(|_| "UPDATE_STATE_UNAVAILABLE")?;
        active
            .as_ref()
            .ok_or("UPDATE_NOT_RUNNING")?
            .store(true, Ordering::SeqCst);
        Ok(())
    }
}
impl Operation {
    pub fn flag(&self) -> Arc<AtomicBool> {
        self.flag.clone()
    }
}
impl Drop for Operation {
    fn drop(&mut self) {
        if let Ok(mut active) = self.slot.lock()
            && active
                .as_ref()
                .is_some_and(|flag| Arc::ptr_eq(flag, &self.flag))
        {
            *active = None;
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn queued_operation_keeps_early_cancel_and_next_operation_is_independent() {
        let slot = CancellationSlot::default();
        let queued = slot.begin().unwrap();
        assert!(slot.begin().is_err());
        slot.cancel().unwrap();
        // The blocking worker has not started. Binding this token must preserve cancellation.
        let worker_flag = queued.flag();
        assert!(worker_flag.load(Ordering::SeqCst));
        drop(queued);
        assert!(slot.cancel().is_err());
        let next = slot.begin().unwrap();
        assert!(!next.flag().load(Ordering::SeqCst));
        slot.cancel().unwrap();
        assert!(next.flag().load(Ordering::SeqCst));
        assert!(worker_flag.load(Ordering::SeqCst));
    }
}
