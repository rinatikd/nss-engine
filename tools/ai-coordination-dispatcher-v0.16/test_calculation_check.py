import unittest

from calculation_check import validate_calculation


class CalculationCheckTests(unittest.TestCase):
    def test_correct_plain_and_formula_results(self):
        answers = [
            "Поток: 8 Мбит/с.\nАрхив: 86.4 ГБ.",
            "4 × 2 Мбит/с = 8 Мбит/с; архив: 8 / 8 × 86400 / 1000 = 86.4 ГБ",
            "Поток: 8 Мбит / с\nАрхив: 86,4 ГБ",
            "Flow: 8 Mbps; Archive: 86.4 GB",
            "8 Mbit / s; 86.4 GB",
            "8 Mb/s; 86.4 GB",
            "8.000 Мбит/с; 86.400 ГБ",
            "+8 Мбит/с; +86.4 ГБ",
            "8\u00a0Мбит / с; 86,4\u00a0ГБ",
        ]
        for answer in answers:
            with self.subTest(answer=answer):
                self.assertIsNone(validate_calculation(answer))

    def test_correct_markdown_and_limited_latex(self):
        answers = [
            "**Поток:** **8 Мбит/с**\n**Архив:** **86,4 ГБ**",
            "`8 Mbps` и __86.4 GB__",
            r"Поток: \(4\times2=8\;\text{Мбит/с}\). Архив: \(86.4\;\text{ГБ}\).",
            r"Поток: $8\,\mathrm{Мбит}/с$; архив: $86{,}4\qquad\textrm{ГБ}$",
            r"\({8}\,\text{Мбит / с}\); \({86.4}\,\mathrm{GB}\)",
        ]
        for answer in answers:
            with self.subTest(answer=answer):
                self.assertIsNone(validate_calculation(answer))

    def test_wrong_values_and_numeric_substrings_fail(self):
        answers = [
            "16 Мбит/с; 86.4 ГБ", "18 Мбит/с; 86.4 ГБ",
            "0.8 Мбит/с; 86.4 ГБ", ".8 Мбит/с; 86.4 ГБ",
            "8 Мбит/с; 186.4 ГБ", "8 Мбит/с; 86.41 ГБ",
            "8 Мбит/с; 864 ГБ", "8 Мбит/с; 0.86.4 ГБ",
            "x8 Мбит/с; 86.4 ГБ", "8 Мбит/с; x86.4 ГБ",
            "1\u200b8 Мбит/с; 86.4 ГБ", "8e0 Мбит/с; 86.4 ГБ",
        ]
        for answer in answers:
            with self.subTest(answer=answer), self.assertRaises(ValueError):
                validate_calculation(answer)

    def test_negative_values_survive_presentation_normalization(self):
        answers = [
            "-8 Мбит/с; 86.4 ГБ", "8 Мбит/с; -86.4 ГБ",
            "−8 Мбит/с; 86.4 ГБ", "8 Мбит/с; −86.4 ГБ",
            "- 8 Мбит/с; 86.4 ГБ", "8 Мбит/с; - 86.4 ГБ",
            r"\(-\,8\;\text{Мбит/с}\); 86.4 ГБ",
            r"8 Мбит/с; \({-86.4}\;\mathrm{ГБ}\)",
            "**-8 Мбит/с**; **86.4 ГБ**",
        ]
        for answer in answers:
            with self.subTest(answer=answer), self.assertRaises(ValueError):
                validate_calculation(answer)

    def test_wrong_units_do_not_become_bytes_or_bits(self):
        answers = [
            "8 MB/s; 86.4 GB", "8 MBps; 86.4 GB", "8 МБ/с; 86.4 ГБ",
            "8 Mbyte/s; 86.4 GB", "8 мбит/с; 86.4 ГБ",
            "8 Mbps; 86.4 Gb", "8 Мбит/с; 86.4 Гб",
            "8 Mbps; 86.4 GiB", "8 Мбит/с; 86.4 ГиБ",
            "8 Mbps; 86.4 GB/s", "8 Мбит/с; 86.4 ГБ / с",
            "8 Mbps; 86.4 GB^2", "8 MbpsExtra; 86.4 GB",
        ]
        for answer in answers:
            with self.subTest(answer=answer), self.assertRaises(ValueError):
                validate_calculation(answer)

    def test_later_wrong_conclusions_cannot_hide_behind_valid_values(self):
        answers = [
            "Поток 8 Mbps, окончательный поток 16 Mbps; архив 86.4 GB",
            "8 Mbps; архив 86.4 GB; окончательный архив -86.4 GB",
            "8 Mbps; 86.4 GB, окончательный архив 86.4 Gb",
            "8 Mbps; окончательный поток 8 MB/s; 86.4 GB",
        ]
        for answer in answers:
            with self.subTest(answer=answer), self.assertRaises(ValueError):
                validate_calculation(answer)

    def test_empty_nontext_and_excessive_input_fail(self):
        for answer in (None, 8, "", "  ", "x" * 20001):
            with self.subTest(type=type(answer).__name__), self.assertRaises(ValueError):
                validate_calculation(answer)


if __name__ == "__main__":
    unittest.main()
