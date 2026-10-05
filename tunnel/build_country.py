#!/usr/bin/env python3
"""Build country.db from the five public RIR delegated-extended files.

Most-specific prefix wins. Adjacent ranges of the same country are joined.
The result is a few megabytes of ranges, not the raw files. No license key
and no request to a geolocation service.
"""

import heapq
import ipaddress
import os
import struct
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCES = (
    "ripencc",
    "arin",
    "apnic",
    "lacnic",
    "afrinic",
)


def cover(ranges):
    """Non-overlapping inclusive ranges. The smaller span wins an overlap."""
    events = []
    for seq, (start, end, cc) in enumerate(ranges):
        if start > end or not cc:
            continue
        events.append((start, 0, end - start, seq, end, cc))
        events.append((end + 1, 1, 0, seq, end, cc))
    events.sort()
    heap = []
    result = []
    current = None
    current_at = None
    index = 0
    while index < len(events):
        pos = events[index][0]
        while index < len(events) and events[index][0] == pos:
            _, kind, span, seq, end, cc = events[index]
            if kind == 0:
                heapq.heappush(heap, (span, seq, end, cc))
            index += 1
        while heap and heap[0][2] < pos:
            heapq.heappop(heap)
        cc_now = heap[0][3] if heap else None
        if cc_now != current:
            if current is not None and current_at <= pos - 1:
                result.append((current_at, pos - 1, current))
            current = cc_now
            current_at = pos if cc_now else None
    merged = []
    for start, end, cc in result:
        if start > end:
            continue
        if merged and merged[-1][2] == cc and merged[-1][1] + 1 == start:
            merged[-1] = (merged[-1][0], end, cc)
        else:
            merged.append((start, end, cc))
    return merged


def pack(v4, v6):
    out = bytearray()
    out += b"GROGCTRY"
    out += struct.pack(">HI", 1, len(v4))
    for start, end, cc in v4:
        out += struct.pack(">II", start, end)
        out += cc.encode("ascii")
    out += struct.pack(">I", len(v6))
    for start, end, cc in v6:
        out += int(start).to_bytes(16, "big")
        out += int(end).to_bytes(16, "big")
        out += cc.encode("ascii")
    return bytes(out)


def parse_files(paths):
    v4 = []
    v6 = []
    for path in paths:
        with open(path, encoding="latin-1") as handle:
            for line in handle:
                if not line or line[0] == "#":
                    continue
                parts = line.rstrip("\n").split("|")
                if len(parts) < 7:
                    continue
                cc = parts[1].upper()
                kind = parts[2]
                status = parts[6].lower()
                if kind not in ("ipv4", "ipv6"):
                    continue
                if not (status.startswith("allocated") or status.startswith("assigned")):
                    continue
                if len(cc) != 2 or not cc.isalpha() or cc == "ZZ":
                    continue
                if kind == "ipv4":
                    try:
                        start = int(ipaddress.IPv4Address(parts[3]))
                        count = int(parts[4])
                    except ValueError:
                        continue
                    end = start + count - 1
                    if count <= 0 or end > 0xFFFFFFFF:
                        continue
                    v4.append((start, end, cc))
                else:
                    try:
                        prefix = int(parts[4])
                        network = ipaddress.IPv6Network(f"{parts[3]}/{prefix}", strict=False)
                    except ValueError:
                        continue
                    if prefix <= 0 or prefix > 128:
                        continue
                    v6.append((int(network.network_address), int(network.broadcast_address), cc))
    return v4, v6


def fetch(cache):
    os.makedirs(cache, exist_ok=True)
    paths = []
    for name in SOURCES:
        destination = os.path.join(cache, f"{name}.txt")
        if not os.path.exists(destination) or os.path.getsize(destination) < 1000:
            url = f"https://ftp.ripe.net/pub/stats/{name}/delegated-{name}-extended-latest"
            urllib.request.urlretrieve(url, destination)
        paths.append(destination)
    return paths


def main():
    cache = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, ".rir-cache")
    out = os.path.join(HERE, "country.db")
    v4, v6 = parse_files(fetch(cache))
    v4 = cover(v4)
    v6 = cover(v6)
    blob = pack(v4, v6)
    temporary = out + ".tmp"
    with open(temporary, "wb") as handle:
        handle.write(blob)
    os.replace(temporary, out)
    print(f"ipv4 {len(v4)} ipv6 {len(v6)} bytes {len(blob)} -> {out}")


if __name__ == "__main__":
    main()
