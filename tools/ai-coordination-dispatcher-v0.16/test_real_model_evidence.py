import copy
import hashlib
import json
import unittest
from verify_real_model import validate_task


def sample():
    answer = "Поток: 4 × 2 = 8 Мбит/с.\nАрхив: 8 / 8 × 86400 / 1000 = 86.4 ГБ."
    verdict = json.dumps({"decision": "APPROVE", "evidence_gaps": []})
    def attempt(role, text):
        return {"role": role, "state": "RESPONDED", "result": {
            "provider": "ollama", "text": text, "sha256": hashlib.sha256(text.encode()).hexdigest(),
            "stop_reason": "end_turn", "usage": {"output_tokens": 32}}}
    return {"state": "COMPLETED", "spec": {"mode": "local"}, "answer": answer,
            "attempts": [attempt("executor", answer), attempt("reviewer", verdict)]}


class RealModelEvidenceTests(unittest.TestCase):
    def test_valid_evidence_shape(self):
        validate_task(sample())

    def test_mock_provider_never_establishes_readiness(self):
        task = sample();task["attempts"][0]["result"]["provider"] = "mock"
        with self.assertRaises(ValueError):validate_task(task)

    def test_incorrect_units_or_flow_fail_independently_of_review(self):
        task = sample();task["answer"] = "8 байтов, поток 16 Мбит/с, архив 86.4 ГБ"
        task["attempts"][0]["result"]["text"] = task["answer"]
        task["attempts"][0]["result"]["sha256"] = hashlib.sha256(task["answer"].encode()).hexdigest()
        with self.assertRaises(ValueError):validate_task(task)

    def test_missing_measured_generation_rejected(self):
        task = sample();task["attempts"][1]["result"]["usage"] = {"output_tokens": 0}
        with self.assertRaises(ValueError):validate_task(task)

    def test_modified_answer_evidence_rejected(self):
        task = sample();task["attempts"][0]["result"]["sha256"] = "0" * 64
        with self.assertRaises(ValueError):validate_task(task)


if __name__ == "__main__":
    unittest.main()
