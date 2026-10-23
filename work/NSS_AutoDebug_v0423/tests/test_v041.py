import unittest
from nss_engine.runtime_validation_v041 import validate

BASE = {"schema_version":"0.41", "drawing_name":"site.dwg", "insunits":"Meters",
        "counts":{"lines":2,"polylines":3,"blocks":1,"other":0,"failed":0}}
class TestV041(unittest.TestCase):
    def test_valid(self):
        self.assertTrue(validate(BASE)["valid"])
    def test_total(self):
        self.assertEqual(validate(BASE)["object_count"], 6)
    def test_schema(self):
        self.assertIn("INVALID_SCHEMA", validate({})["issues"])
    def test_counts_missing(self):
        self.assertIn("INVALID_COUNTS", validate({"schema_version":"0.41"})["issues"])
    def test_negative(self):
        x={**BASE,"counts":{**BASE["counts"],"lines":-1}}
        self.assertFalse(validate(x)["valid"])
    def test_bool_not_int(self):
        x={**BASE,"counts":{**BASE["counts"],"lines":True}}
        self.assertFalse(validate(x)["valid"])
    def test_units(self):
        self.assertIn("UNITS_UNCONFIRMED",validate({**BASE,"insunits":"Undefined"})["issues"])
    def test_failures(self):
        x={**BASE,"counts":{**BASE["counts"],"failed":1}}
        self.assertIn("OBJECT_READ_FAILURES",validate(x)["issues"])
    def test_name(self):
        self.assertIn("MISSING_DRAWING_NAME",validate({**BASE,"drawing_name":""})["issues"])
