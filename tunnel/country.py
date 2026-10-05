"""Country of an IP address, from a table built by build_country.py.

The table is the public RIR delegation files, packed as sorted ranges.
A missing or unreadable file means no country. Private and loopback
addresses are empty. This module does not log the address.
"""

import ipaddress
import os
import struct

MAGIC = b"GROGCTRY"
VERSION = 1
V4_SIZE = 10
V6_SIZE = 34

_table = None
_loaded_path = None


class Table:
    def __init__(self, blob):
        if len(blob) < 18 or blob[:8] != MAGIC:
            raise ValueError("not a country table")
        version, self.n4 = struct.unpack_from(">HI", blob, 8)
        if version != VERSION:
            raise ValueError("unsupported country table")
        self.blob = blob
        self.v4_off = 14
        v6_count_at = self.v4_off + self.n4 * V4_SIZE
        if len(blob) < v6_count_at + 4:
            raise ValueError("truncated country table")
        self.n6 = struct.unpack_from(">I", blob, v6_count_at)[0]
        self.v6_off = v6_count_at + 4
        if len(blob) < self.v6_off + self.n6 * V6_SIZE:
            raise ValueError("truncated country table")

    def _find(self, ip, offset, count, size, start_end):
        lo, hi = 0, count
        while lo < hi:
            mid = (lo + hi) // 2
            at = offset + mid * size
            start, end = start_end(at)
            if ip < start:
                hi = mid
            elif ip > end:
                lo = mid + 1
            else:
                raw = self.blob[at + size - 2:at + size]
                try:
                    cc = raw.decode("ascii")
                except UnicodeDecodeError:
                    return ""
                return cc if len(cc) == 2 and cc.isalpha() and cc.isupper() else ""
        return ""

    def v4(self, ip):
        return self._find(
            ip, self.v4_off, self.n4, V4_SIZE,
            lambda at: struct.unpack_from(">II", self.blob, at),
        )

    def v6(self, ip):
        def start_end(at):
            start = int.from_bytes(self.blob[at:at + 16], "big")
            end = int.from_bytes(self.blob[at + 16:at + 32], "big")
            return start, end
        return self._find(ip, self.v6_off, self.n6, V6_SIZE, start_end)


def db_path():
    return os.environ.get("GROG_COUNTRY_DB") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "country.db")


def load(path):
    try:
        with open(path, "rb") as handle:
            blob = handle.read()
    except OSError:
        return None
    try:
        return Table(blob)
    except ValueError:
        return None


def country_of(ip):
    """Two-letter country for a public address, or ""."""
    global _table, _loaded_path
    wanted = db_path()
    if _loaded_path != wanted:
        _table = load(wanted)
        _loaded_path = wanted
    if not ip or _table is None:
        return ""
    try:
        addr = ipaddress.ip_address(str(ip).split("%", 1)[0])
    except ValueError:
        return ""
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped is not None:
        addr = addr.ipv4_mapped
    if any(getattr(addr, name, False) for name in ("is_private", "is_loopback", "is_link_local", "is_reserved", "is_multicast", "is_unspecified")):
        return ""
    if isinstance(addr, ipaddress.IPv4Address):
        return _table.v4(int(addr))
    return _table.v6(int(addr))
