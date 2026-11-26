#pragma once

namespace powershell_direct {

enum class OperationState {
  kRegistered,
  kStarting,
  kRunning,
  kTerminating,
  kCompleted,
  kClosed
};

constexpr bool can_transition(OperationState from, OperationState to) noexcept {
  switch (from) {
    case OperationState::kRegistered:
      return to == OperationState::kStarting || to == OperationState::kClosed;
    case OperationState::kStarting:
      return to == OperationState::kRunning || to == OperationState::kTerminating;
    case OperationState::kRunning:
      return to == OperationState::kTerminating || to == OperationState::kCompleted;
    case OperationState::kTerminating:
      return to == OperationState::kCompleted;
    case OperationState::kCompleted:
      return to == OperationState::kClosed;
    case OperationState::kClosed:
      return false;
  }
  return false;
}

}  // namespace powershell_direct
