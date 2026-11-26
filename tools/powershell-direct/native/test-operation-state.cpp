#include "operation-state.h"

#include <cstdlib>
#include <iostream>

using powershell_direct::OperationState;
using powershell_direct::can_transition;

#define CHECK_EDGE(from, to, expected) do { \
  if (can_transition(OperationState::from, OperationState::to) != (expected)) { \
    std::cerr << "transition assertion failed: " #from " -> " #to "\n"; \
    return EXIT_FAILURE; \
  } \
} while (false)

int main() {
  CHECK_EDGE(kRegistered, kStarting, true);
  CHECK_EDGE(kRegistered, kClosed, true);
  CHECK_EDGE(kRegistered, kRunning, false);
  CHECK_EDGE(kStarting, kRunning, true);
  CHECK_EDGE(kStarting, kTerminating, true);
  CHECK_EDGE(kStarting, kCompleted, false);
  CHECK_EDGE(kRunning, kTerminating, true);
  CHECK_EDGE(kRunning, kCompleted, true);
  CHECK_EDGE(kRunning, kClosed, false);
  CHECK_EDGE(kTerminating, kCompleted, true);
  CHECK_EDGE(kTerminating, kClosed, false);
  CHECK_EDGE(kCompleted, kClosed, true);
  CHECK_EDGE(kCompleted, kRunning, false);
  CHECK_EDGE(kClosed, kClosed, false);
  CHECK_EDGE(kClosed, kRunning, false);
  std::cout << "PASS: native operation state transition table\n";
  return EXIT_SUCCESS;
}
