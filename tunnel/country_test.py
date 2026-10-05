#!/usr/bin/env python3
"""Country table and the site-domain header stamp. No network."""

import ipaddress
import os
import tempfile
import unittest

import build_country
import country
import relay


def v4(text):
    return int(ipaddress.IPv4Address(text))


class CountryTest(unittest.TestCase):
    def setUp(self):
        self._contexts = dict(relay.site_contexts)
        self._env = os.environ.get("GROG_COUNTRY_DB")
        ranges = build_country.cover([
            (v4("1.2.0.0"), v4("1.2.255.255"), "US"),
            (v4("1.2.3.0"), v4("1.2.3.255"), "IT"),
            (v4("1.2.3.10"), v4("1.2.3.10"), "FR"),
            (v4("8.8.8.0"), v4("8.8.8.255"), "US"),
            (v4("9.9.9.0"), v4("9.9.9.10"), "DE"),
            (v4("9.9.9.11"), v4("9.9.9.20"), "DE"),
        ])
        self.assertEqual(ranges, [
            (v4("1.2.0.0"), v4("1.2.2.255"), "US"),
            (v4("1.2.3.0"), v4("1.2.3.9"), "IT"),
            (v4("1.2.3.10"), v4("1.2.3.10"), "FR"),
            (v4("1.2.3.11"), v4("1.2.3.255"), "IT"),
            (v4("1.2.4.0"), v4("1.2.255.255"), "US"),
            (v4("8.8.8.0"), v4("8.8.8.255"), "US"),
            (v4("9.9.9.0"), v4("9.9.9.20"), "DE"),
        ])
        blob = build_country.pack(ranges, [
            (int(ipaddress.IPv6Address("2001:678::")), int(ipaddress.IPv6Address("2001:678::ffff")), "IT"),
        ])
        self.file = tempfile.NamedTemporaryFile(delete=False)
        self.file.write(blob)
        self.file.close()
        os.environ["GROG_COUNTRY_DB"] = self.file.name
        country._loaded_path = None

    def tearDown(self):
        relay.site_contexts = self._contexts
        country._loaded_path = None
        if self._env is None:
            os.environ.pop("GROG_COUNTRY_DB", None)
        else:
            os.environ["GROG_COUNTRY_DB"] = self._env
        os.unlink(self.file.name)

    def test_lookup(self):
        self.assertEqual(country.country_of("1.2.3.4"), "IT")
        self.assertEqual(country.country_of("1.2.3.10"), "FR")
        self.assertEqual(country.country_of("1.2.4.1"), "US")
        self.assertEqual(country.country_of("::ffff:1.2.3.4"), "IT")
        self.assertEqual(country.country_of("2001:678::1"), "IT")
        self.assertEqual(country.country_of("2001:679::1"), "")
        self.assertEqual(country.country_of("9.9.9.9"), "DE")
        self.assertEqual(country.country_of("127.0.0.1"), "")
        self.assertEqual(country.country_of("10.1.1.1"), "")
        self.assertEqual(country.country_of("::1"), "")
        self.assertEqual(country.country_of(""), "")
        self.assertEqual(country.country_of("not-an-ip"), "")

    def test_stamp_only_rewrites_a_site_domain(self):
        relay.site_contexts = {"alien.test": object()}
        head = b"GET /a?token=1 HTTP/1.1\r\nHost: www.alien.test\r\nX-Grog-Country: US\r\n\r\nBODY"
        stamped = relay.prepare_head(head, "www.alien.test", "1.2.3.4")
        self.assertIn(b"x-grog-country: IT", stamped)
        self.assertNotIn(b"US", stamped)
        self.assertTrue(stamped.endswith(b"\r\n\r\nBODY"))
        self.assertTrue(stamped.startswith(b"GET /a?token=1 HTTP/1.1\r\nHost: www.alien.test\r\n"))
        untouched = b"GET / HTTP/1.1\r\nHost: www.alien.test\r\n\r\n"
        self.assertEqual(relay.prepare_head(untouched, "www.alien.test", "127.0.0.1"), untouched)
        public = b"GET / HTTP/1.1\r\nHost: demo.grog.test\r\nX-Grog-Country: US\r\n\r\n"
        self.assertEqual(relay.prepare_head(public, "demo.grog.test", "8.8.8.8"), public)
        self.assertIsNone(relay.site_of("demo.grog.test"))
        self.assertEqual(relay.site_of("www.alien.test"), "alien.test")


if __name__ == "__main__":
    unittest.main()
