#include "synchronized-operation-state.h"

#include <atomic>
#include <cstdlib>
#include <iostream>
#include <thread>
#include <vector>

using powershell_direct::OperationState;
using powershell_direct::SynchronizedOperationState;

int main() {
  SynchronizedOperationState state;
  std::atomic<unsigned int> winners{0};
  std::vector<std::thread> contenders;
  for (unsigned int i = 0; i < 24; ++i) {
    contenders.emplace_back([&state, &winners]() {
      if (state.try_transition(OperationState::kStarting)) {
        winners.fetch_add(1, std::memory_order_relaxed);
      }
    });
  }
  for (auto& thread : contenders) thread.join();

  if (winners.load(std::memory_order_relaxed) != 1 ||
      state.snapshot() != OperationState::kStarting) {
    std::cerr << "FAIL: competing REGISTERED -> STARTING transitions\n";
    return EXIT_FAILURE;
  }

  if (!state.try_transition(OperationState::kRunning)) {
    std::cerr << "FAIL: STARTING -> RUNNING transition\n";
    return EXIT_FAILURE;
  }

  std::atomic<unsigned int> terminal_winners{0};
  std::thread terminate([&]() {
    if (state.try_transition(OperationState::kTerminating)) {
      terminal_winners.fetch_add(1, std::memory_order_relaxed);
    }
  });
  std::thread complete([&]() {
    if (state.try_transition(OperationState::kCompleted)) {
      terminal_winners.fetch_add(1, std::memory_order_relaxed);
    }
  });
  terminate.join();
  complete.join();

  const auto final_state = state.snapshot();
  const bool valid_final =
      final_state == OperationState::kTerminating ||
      final_state == OperationState::kCompleted;
  if (terminal_winners.load(std::memory_order_relaxed) != 1 || !valid_final) {
    std::cerr << "FAIL: competing RUNNING terminal transitions\n";
    return EXIT_FAILURE;
  }

  if (state.try_transition(OperationState::kClosed)) {
    std::cerr << "FAIL: active/terminating state must not close\n";
    return EXIT_FAILURE;
  }
  std::cout << "PASS: synchronized operation state concurrency tests\n";
  return EXIT_SUCCESS;
}
