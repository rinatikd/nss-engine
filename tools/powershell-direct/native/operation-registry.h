#pragma once

#include <cstddef>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <utility>

namespace powershell_direct {

// Owns shared operation records independently of registry membership. A caller
// must retain the returned shared_ptr before releasing the registry lock; this
// keeps a record alive while lifecycle state or OS resources are inspected.
template <typename Record>
class OperationRegistry {
 public:
  explicit OperationRegistry(
      std::size_t tombstone_limit = 4096)
      : tombstone_limit_(tombstone_limit) {}

  OperationRegistry(const OperationRegistry&) = delete;
  OperationRegistry& operator=(const OperationRegistry&) = delete;

  bool insert_if_absent(const std::string& id,
                        const std::shared_ptr<Record>& record) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (records_.find(id) != records_.end() ||
        closed_.find(id) != closed_.end()) {
      return false;
    }
    return records_.emplace(id, record).second;
  }

  std::shared_ptr<Record> find(const std::string& id) const {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto found = records_.find(id);
    return found == records_.end() ? nullptr : found->second;
  }

  bool is_closed(const std::string& id) const {
    std::lock_guard<std::mutex> lock(mutex_);
    return closed_.find(id) != closed_.end();
  }

  // Erase only the exact record whose lifecycle was transitioned by the
  // caller. Erasure and tombstone insertion are one registry transaction.
  bool erase_and_tombstone(const std::string& id,
                           const std::shared_ptr<Record>& expected) {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto found = records_.find(id);
    if (found == records_.end() || found->second != expected) return false;
    records_.erase(found);
    closed_.insert(id);
    closed_order_.push_back(id);
    while (closed_order_.size() > tombstone_limit_) {
      closed_.erase(closed_order_.front());
      closed_order_.pop_front();
    }
    return true;
  }

 private:
  const std::size_t tombstone_limit_;
  mutable std::mutex mutex_;
  std::unordered_map<std::string, std::shared_ptr<Record>> records_;
  std::unordered_set<std::string> closed_;
  std::deque<std::string> closed_order_;
};

}  // namespace powershell_direct
