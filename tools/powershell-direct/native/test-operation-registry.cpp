#include "operation-registry.h"
#include "synchronized-operation-state.h"

#include <atomic>
#include <cstdlib>
#include <iostream>
#include <memory>
#include <string>
#include <thread>
#include <vector>

using powershell_direct::OperationRegistry;
using powershell_direct::OperationState;
using powershell_direct::SynchronizedOperationState;

struct TestRecord {
  SynchronizedOperationState lifecycle;
};

int main() {
  OperationRegistry<TestRecord> registry;
  auto record = std::make_shared<TestRecord>();
  std::weak_ptr<TestRecord> weak_record = record;
  if (!registry.insert_if_absent("operation-a", record)) {
    std::cerr << "FAIL: initial registry insert\n";
    return EXIT_FAILURE;
  }
  record.reset();

  std::atomic<unsigned int> close_successes{0};
  std::atomic<unsigned int> transition_winners{0};
  std::vector<std::thread> closers;
  for (unsigned int i = 0; i < 32; ++i) {
    closers.emplace_back([&]() {
      auto retained = registry.find("operation-a");
      if (!retained) {
        if (registry.is_closed("operation-a")) {
          close_successes.fetch_add(1, std::memory_order_relaxed);
        }
        return;
      }

      if (retained->lifecycle.compare_transition(OperationState::kRegistered,
                                                  OperationState::kClosed)) {
        transition_winners.fetch_add(1, std::memory_order_relaxed);
        if (!registry.erase_and_tombstone("operation-a", retained)) {
          return;
        }
        close_successes.fetch_add(1, std::memory_order_relaxed);
      } else if (retained->lifecycle.snapshot() == OperationState::kClosed) {
        close_successes.fetch_add(1, std::memory_order_relaxed);
      }
    });
  }
  for (auto& closer : closers) closer.join();

  if (transition_winners.load(std::memory_order_relaxed) != 1 ||
      close_successes.load(std::memory_order_relaxed) != 32 ||
      registry.find("operation-a") ||
      !registry.is_closed("operation-a")) {
    std::cerr << "FAIL: concurrent close and tombstone behavior\n";
    return EXIT_FAILURE;
  }

  // A retained shared_ptr keeps the record alive after registry erasure.
  if (weak_record.expired()) {
    std::cerr << "FAIL: record lifetime ended while a closer retained it\n";
    return EXIT_FAILURE;
  }

  auto replacement = std::make_shared<TestRecord>();
  if (registry.insert_if_absent("operation-a", replacement)) {
    std::cerr << "FAIL: tombstoned ID was reused\n";
    return EXIT_FAILURE;
  }

  OperationRegistry<TestRecord> bounded_registry(1);
  auto first = std::make_shared<TestRecord>();
  auto second = std::make_shared<TestRecord>();
  if (!bounded_registry.insert_if_absent("first", first) ||
      !first->lifecycle.compare_transition(OperationState::kRegistered,
                                           OperationState::kClosed) ||
      !bounded_registry.erase_and_tombstone("first", first) ||
      !bounded_registry.insert_if_absent("second", second) ||
      !second->lifecycle.compare_transition(OperationState::kRegistered,
                                            OperationState::kClosed) ||
      !bounded_registry.erase_and_tombstone("second", second) ||
      bounded_registry.is_closed("first") ||
      !bounded_registry.is_closed("second")) {
    std::cerr << "FAIL: bounded tombstone retention\n";
    return EXIT_FAILURE;
  }

  std::cout << "PASS: shared operation registry concurrency tests\n";
  return EXIT_SUCCESS;
}
