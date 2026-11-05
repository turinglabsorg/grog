#!/usr/bin/env python3
"""Fixed and wildcard site claims, and which link answers a host. No network."""

import unittest

import relay


class WildcardTest(unittest.TestCase):
    def setUp(self):
        self._contexts = dict(relay.site_contexts)
        self._tunnels = dict(relay.tunnels)
        relay.site_contexts.clear()
        relay.site_contexts["usecora.space"] = object()
        relay.tunnels.clear()

    def tearDown(self):
        relay.site_contexts.clear()
        relay.site_contexts.update(self._contexts)
        relay.tunnels.clear()
        relay.tunnels.update(self._tunnels)

    def open(self, host):
        tunnel = relay.Tunnel(host, "secret", "port 4380")
        tunnel.control = object()
        relay.tunnels[host] = tunnel
        return tunnel

    def test_only_a_site_domain_can_be_claimed_whole(self):
        self.assertTrue(relay.claimable("*.usecora.space"))
        self.assertFalse(relay.claimable("*.example.com"))
        self.assertFalse(relay.claimable("*.a.usecora.space"))
        self.assertFalse(relay.claimable("*"))
        self.assertTrue(relay.claimable("notseb.usecora.space"))

    def test_a_name_with_no_claim_of_its_own_goes_to_the_wildcard(self):
        wild = self.open("*.usecora.space")
        exact = self.open("notseb.usecora.space")
        self.assertIs(relay.tunnel_for("notseb.usecora.space"), exact)
        self.assertIs(relay.tunnel_for("report--dopamina.usecora.space"), wild)
        self.assertIsNone(relay.tunnel_for("usecora.space"), "the apex is never the wildcard's")
        self.assertIsNone(relay.tunnel_for("a.b.usecora.space"), "two labels down is not covered")
        self.assertIsNone(relay.tunnel_for("x.example.com"))
        exact.control = None
        self.assertIs(relay.tunnel_for("notseb.usecora.space"), wild, "a claim whose client is gone falls back")
        wild.control = None
        self.assertIsNone(relay.tunnel_for("report--dopamina.usecora.space"), "nothing open: the visitor gets the site-offline page")


if __name__ == "__main__":
    unittest.main()
