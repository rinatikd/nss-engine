#pragma once

#include "operation-state.h"

#include <mutex>

namespace powershell_direct {

// Serializes state transitions for one operation. The caller must retain the
// owning operation record while invoking this object; registry locks are not
// part of this class and must never be held across blocking OS waits.
class SynchronizedOperationState {
 public:
  explicit SynchronizedOperationState(
      OperationState initial = OperationState::kRegistered) noexcept
      : state_(initial) {}

  SynchronizedOperationState(const SynchronizedOperationState&) = delete;
  SynchronizedOperationState& operator=(const SynchronizedOperationState&) = delete;

  bool try_transition(OperationState next) noexcept {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!can_transition(state_, next)) return false;
    state_ = next;
    return true;
  }

  OperationState snapshot() const noexcept {
    std::lock_guard<std::mutex> lock(mutex_);
    return state_;
  }

 private:
  mutable std::mutex mutex_;
  OperationState state_;
};

}  // namespace powershell_direct
