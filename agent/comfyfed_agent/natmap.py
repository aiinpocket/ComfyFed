"""Agent-side automatic port mapping (Phase 3.4 §3, 純 stdlib).

Asks the home router to open a TCP port for the peer HTTP server, so a
worker behind a consumer NAT can seed models to members outside its LAN --
the eMule/Foxy "HighID" trick. NAT-PMP (RFC 6886) first because it is one
UDP round trip, then UPnP IGD (SSDP + SOAP) because more routers speak it.

EVERYTHING here is synchronous and blocking by design: the caller
(`runner._start_peer_server`) runs it inside `asyncio.to_thread`, exactly
like `hardware.collect_hardware`. Nothing here imports outside the standard
library (Global Constraints), and nothing ever raises out of `map_port` /
`unmap_port` -- a router that does not answer is the expected case, not a
fault.

All I/O goes through three injectable transport protocols plus an injectable
gateway detector, so the whole orchestrator is unit-testable with fakes and a
fake clock: no test ever touches a real socket, a real router, or the real
routing table.

Single cross-module dependency: when the caller does not pass `local_ip`,
`map_port` falls back to `peerserve._detect_local_ip()` (imported lazily
inside the function, so importing this module stays free of side effects).
"""

from __future__ import annotations

import ipaddress
import logging
import re
import socket
import struct
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from typing import Callable, Iterable, Optional, Protocol
from urllib.parse import urljoin

logger = logging.getLogger(__name__)

# Global Constraints：整體上限 8 秒、lease 3600 秒、續租每 30 分鐘、
# NAT-PMP 重送 250ms 起倍增最多 3 次、SSDP 等 2.5 秒。
MAP_DEADLINE_SECONDS = 8.0
LEASE_SECONDS = 3600
RENEW_SECONDS = 1800
NATPMP_PORT = 5351
NATPMP_RETRY_DELAYS = (0.25, 0.5, 1.0)
SSDP_ADDRESS = "239.255.255.250"
SSDP_PORT = 1900
SSDP_WAIT_SECONDS = 2.5
UPNP_PORT_ATTEMPTS = 5
UPNP_DESCRIPTION = "ComfyFed peer"
# 718 ConflictInMappingEntry：這個外部埠已被別人（或自己上一輪沒清掉的映射）
# 占走，換下一個埠再試。
UPNP_CONFLICT_ERROR = 718

# spec §4.2 的私有網段清單，逐字：10/8、172.16/12、192.168/16、169.254/16、
# fc00::/7、::1；loopback 127/8 與 IPv6 link-local 一併納入（同樣連不到）。
_PRIVATE_NETWORKS = tuple(
    ipaddress.ip_network(cidr)
    for cidr in (
        "10.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "169.254.0.0/16",
        "127.0.0.0/8",
        "fc00::/7",
        "::1/128",
        "fe80::/10",
    )
)

# spec §3.1 第 3 點的優先順序：WANIPConnection:1、WANPPPConnection:1，
# 之後才是 v2 版本。
_SERVICE_TYPES = (
    "urn:schemas-upnp-org:service:WANIPConnection:1",
    "urn:schemas-upnp-org:service:WANPPPConnection:1",
    "urn:schemas-upnp-org:service:WANIPConnection:2",
    "urn:schemas-upnp-org:service:WANPPPConnection:2",
)

M_SEARCH_PAYLOAD = (
    b"M-SEARCH * HTTP/1.1\r\n"
    b"HOST: 239.255.255.250:1900\r\n"
    b'MAN: "ssdp:discover"\r\n'
    b"MX: 2\r\n"
    b"ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n"
    b"\r\n"
)

_SOAP_ENVELOPE = (
    '<?xml version="1.0"?>\n'
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"'
    ' s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">\n'
    '<s:Body><u:{action} xmlns:u="{service}">{args}</u:{action}></s:Body>\n'
    "</s:Envelope>"
)


@dataclass(frozen=True)
class Mapping:
    """一筆成功的對外埠映射。`external_ip` 可能是 None（UPnP 的
    GetExternalIPAddress 失敗，或路由器回報的是私有位址＝雙層 NAT），
    這兩種情況呼叫端都改用平台回報的 `ready.remote_ip`（spec §3.1 第 5 點）。"""

    method: str  # "natpmp" | "upnp"
    external_ip: Optional[str]
    external_port: int
    internal_port: int
    lifetime: int
    gateway: str
    control_url: Optional[str] = None
    service_type: Optional[str] = None


class UdpTransport(Protocol):
    def exchange(self, host: str, port: int, payload: bytes, timeout: float) -> Optional[bytes]:
        """送一個 UDP datagram 並等一個回應；逾時回 None，永不拋例外。"""


class HttpTransport(Protocol):
    def get(self, url: str, timeout: float) -> tuple[int, bytes]:
        ...

    def post(self, url: str, body: bytes, headers: dict[str, str], timeout: float) -> tuple[int, bytes]:
        ...


class SsdpTransport(Protocol):
    def msearch(self, payload: bytes, wait_seconds: float) -> list[bytes]:
        """多播 M-SEARCH 並收集 `wait_seconds` 內的所有回應 datagram。"""


# --- 閘道偵測（spec §3.1 第 1 點）-----------------------------------------


def _run_command(argv: list[str]) -> str:
    return subprocess.run(argv, capture_output=True, text=True, timeout=3, check=False).stdout


def parse_windows_route(output: str) -> Optional[str]:
    """`route print -4 0.0.0.0` 的 `0.0.0.0 0.0.0.0 <gateway>` 那一列。"""
    for line in output.splitlines():
        fields = line.split()
        if len(fields) >= 3 and fields[0] == "0.0.0.0" and fields[1] == "0.0.0.0":
            candidate = fields[2]
            if candidate.lower() == "on-link":
                continue
            try:
                ipaddress.ip_address(candidate)
            except ValueError:
                continue
            return candidate
    return None


def parse_macos_route(output: str) -> Optional[str]:
    """`route -n get default` 的 `gateway: <ip>` 那一行。"""
    match = re.search(r"^\s*gateway:\s*(\S+)\s*$", output, re.MULTILINE)
    return match.group(1) if match else None


def parse_linux_ip_route(output: str) -> Optional[str]:
    """`ip route show default` 的 `default via <ip> dev ...`。"""
    match = re.search(r"^default\s+via\s+(\S+)", output, re.MULTILINE)
    return match.group(1) if match else None


_GATEWAY_COMMANDS: dict[str, tuple[list[str], Callable[[str], Optional[str]]]] = {
    "win32": (["route", "print", "-4", "0.0.0.0"], parse_windows_route),
    "darwin": (["route", "-n", "get", "default"], parse_macos_route),
    "linux": (["ip", "route", "show", "default"], parse_linux_ip_route),
}


def detect_gateway(
    *,
    platform_name: str = sys.platform,
    runner: Callable[[list[str]], str] = _run_command,
) -> Optional[str]:
    """預設閘道 IP；找不到（不認得的平台、指令不存在、輸出不符）回 None --
    呼叫端就放棄映射並記一行 INFO（spec §3.1 第 1 點）。"""
    key = "linux" if platform_name.startswith("linux") else platform_name
    entry = _GATEWAY_COMMANDS.get(key)
    if entry is None:
        return None
    argv, parser = entry
    try:
        return parser(runner(argv))
    except Exception:
        return None


# --- 私有位址判定 ----------------------------------------------------------


def is_private_address(host: str) -> bool:
    """`host` 是 loopback／link-local／私有網段的 IP。非 IP 字串（主機名）
    回 False —— 判不出來就不要假裝判得出來。"""
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    return any(address in network for network in _PRIVATE_NETWORKS)


# --- NAT-PMP 封包（RFC 6886）-----------------------------------------------


def encode_natpmp_request(
    opcode: int, *, internal_port: int = 0, external_port: int = 0, lifetime: int = 0
) -> bytes:
    """opcode 0 = 取外部位址（2 bytes）；opcode 1/2 = UDP/TCP 映射（12 bytes:
    version, opcode, reserved u16, internal u16, external u16, lifetime u32）。
    `lifetime=0` 即刪除映射。"""
    if opcode == 0:
        return struct.pack("!BB", 0, 0)
    return struct.pack("!BBHHHI", 0, opcode, 0, internal_port, external_port, lifetime)


def decode_natpmp_response(data: bytes) -> Optional[dict]:
    """回 `{"opcode", "result", "epoch", ...}`，長度不符回 None。
    opcode 128 帶 `external_ip`；opcode 129/130 帶 `internal_port`/
    `external_port`/`lifetime`。**external_port 一律以回應為準**。"""
    if len(data) == 12 and data[1] == 128:
        _version, opcode, result, epoch = struct.unpack("!BBHI", data[:8])
        return {
            "opcode": opcode,
            "result": result,
            "epoch": epoch,
            "external_ip": ".".join(str(b) for b in data[8:12]),
        }
    if len(data) == 16:
        _version, opcode, result, epoch, internal, external, lifetime = struct.unpack("!BBHIHHI", data)
        return {
            "opcode": opcode,
            "result": result,
            "epoch": epoch,
            "internal_port": internal,
            "external_port": external,
            "lifetime": lifetime,
        }
    return None


# --- UPnP IGD：SSDP 探索、裝置描述、SOAP ------------------------------------


def parse_ssdp_locations(datagrams: Iterable[bytes]) -> list[str]:
    """每個 M-SEARCH 回應的 `LOCATION` 標頭（大小寫不敏感），去重後保序。"""
    locations: list[str] = []
    seen: set[str] = set()
    for datagram in datagrams:
        try:
            text = datagram.decode("utf-8", "replace")
        except Exception:
            continue
        for line in text.splitlines():
            name, _, value = line.partition(":")
            if name.strip().lower() != "location":
                continue
            location = value.strip()
            if location and location not in seen:
                seen.add(location)
                locations.append(location)
    return locations


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def find_control_url(xml_text: str, location: str) -> Optional[tuple[str, str]]:
    """裝置描述 XML 裡 `WANIPConnection:1`（其次 `WANPPPConnection:1`，其次
    `:2` 版本）的 `controlURL`，相對路徑用 `location` 補成絕對 URL。
    回 `(control_url, service_type)`，找不到回 None。"""
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return None

    found: dict[str, str] = {}
    for service in root.iter():
        if _local_name(service.tag) != "service":
            continue
        service_type = None
        control_url = None
        for child in service:
            name = _local_name(child.tag)
            if name == "serviceType":
                service_type = (child.text or "").strip()
            elif name == "controlURL":
                control_url = (child.text or "").strip()
        if service_type in _SERVICE_TYPES and control_url:
            found.setdefault(service_type, control_url)

    for service_type in _SERVICE_TYPES:
        control_url = found.get(service_type)
        if control_url:
            return urljoin(location, control_url), service_type
    return None


def _escape(value: str) -> str:
    return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def build_soap(
    action: str, service_type: str, args: list[tuple[str, str]]
) -> tuple[bytes, dict[str, str]]:
    """一個 SOAP 呼叫的 body 與標頭。參數順序就是 `args` 的順序 —— IGD 的
    schema 是有序的，順序錯了路由器會回 402 Invalid Args。"""
    rendered = "".join(f"<{name}>{_escape(value)}</{name}>" for name, value in args)
    body = _SOAP_ENVELOPE.format(action=action, service=service_type, args=rendered).encode("utf-8")
    headers = {
        "Content-Type": 'text/xml; charset="utf-8"',
        "SOAPAction": f'"{service_type}#{action}"',
        "Connection": "close",
    }
    return body, headers


def parse_soap_error(body: str) -> Optional[int]:
    """SOAP Fault 裡的 `<errorCode>`（718 = ConflictInMappingEntry），
    沒有 fault 回 None。"""
    match = re.search(r"<errorCode>\s*(\d+)\s*</errorCode>", body)
    return int(match.group(1)) if match else None


def parse_external_ip(body: str) -> Optional[str]:
    match = re.search(r"<NewExternalIPAddress>\s*([^<\s]*)\s*</NewExternalIPAddress>", body)
    if match is None:
        return None
    return match.group(1).strip() or None


# --- 真實 transport（只有 map_port 的預設值會用到）--------------------------


class _SocketUdpTransport:
    def exchange(self, host: str, port: int, payload: bytes, timeout: float) -> Optional[bytes]:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.settimeout(max(0.05, timeout))
            sock.sendto(payload, (host, port))
            data, _ = sock.recvfrom(1024)
            return data
        except OSError:
            return None
        finally:
            sock.close()


class _UrllibHttpTransport:
    def get(self, url: str, timeout: float) -> tuple[int, bytes]:
        import urllib.error
        import urllib.request

        try:
            with urllib.request.urlopen(url, timeout=timeout) as resp:  # noqa: S310 (LAN IGD URL)
                return resp.status, resp.read()
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read()
        except Exception:
            return 0, b""

    def post(self, url: str, body: bytes, headers: dict[str, str], timeout: float) -> tuple[int, bytes]:
        import urllib.error
        import urllib.request

        request = urllib.request.Request(url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=timeout) as resp:  # noqa: S310
                return resp.status, resp.read()
        except urllib.error.HTTPError as exc:
            # IGD 的 SOAP Fault 就是走 HTTP 500 回來的，body 要讀出來看
            # errorCode（718 衝突要換埠），不能當一般錯誤丟掉。
            return exc.code, exc.read()
        except Exception:
            return 0, b""


class _MulticastSsdpTransport:
    def msearch(self, payload: bytes, wait_seconds: float) -> list[bytes]:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        responses: list[bytes] = []
        try:
            sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
            sock.settimeout(0.5)
            sock.sendto(payload, (SSDP_ADDRESS, SSDP_PORT))
            deadline = time.monotonic() + wait_seconds
            while time.monotonic() < deadline:
                try:
                    data, _ = sock.recvfrom(4096)
                except socket.timeout:
                    continue
                except OSError:
                    break
                responses.append(data)
        except OSError:
            return responses
        finally:
            sock.close()
        return responses


# --- 協調器（spec §3.1）----------------------------------------------------


def _try_natpmp(
    *, gateway: str, port: int, udp: UdpTransport, clock, sleep, deadline: float
) -> Optional[Mapping]:
    """NAT-PMP：opcode 0 取外部 IP、opcode 2 建 TCP 映射，重送 250ms 起倍增
    最多 3 次。任一步驟沒回應或 result 非 0 就回 None 讓 UPnP 接手。"""

    def _exchange(payload: bytes) -> Optional[dict]:
        for delay in NATPMP_RETRY_DELAYS:
            if clock() >= deadline:
                return None
            data = udp.exchange(gateway, NATPMP_PORT, payload, min(delay, max(0.05, deadline - clock())))
            if data is not None:
                return decode_natpmp_response(data)
            sleep(delay)
        return None

    external = _exchange(encode_natpmp_request(0))
    if external is None or external.get("result") != 0:
        return None

    mapped = _exchange(
        encode_natpmp_request(2, internal_port=port, external_port=port, lifetime=LEASE_SECONDS)
    )
    if mapped is None or mapped.get("result") != 0:
        return None

    external_ip = external.get("external_ip")
    if external_ip and is_private_address(external_ip):
        # 雙層 NAT：路由器自己也在別人後面。交給呼叫端改用 ready.remote_ip。
        external_ip = None

    return Mapping(
        method="natpmp",
        external_ip=external_ip,
        external_port=mapped.get("external_port") or port,
        internal_port=port,
        lifetime=mapped.get("lifetime") or LEASE_SECONDS,
        gateway=gateway,
    )


def _try_upnp(
    *,
    gateway: str,
    port: int,
    local_ip: str,
    http: HttpTransport,
    ssdp: SsdpTransport,
    clock,
    deadline: float,
) -> Optional[Mapping]:
    # SSDP 一開始就要等滿 2.5 秒；剩下的時間不夠就別開始，免得超出 8 秒上限。
    if clock() + SSDP_WAIT_SECONDS > deadline:
        return None

    locations = parse_ssdp_locations(ssdp.msearch(M_SEARCH_PAYLOAD, SSDP_WAIT_SECONDS))
    for location in locations:
        if clock() >= deadline:
            return None
        status, body = http.get(location, max(0.5, deadline - clock()))
        if status != 200 or not body:
            continue
        found = find_control_url(body.decode("utf-8", "replace"), location)
        if found is None:
            continue
        control_url, service_type = found

        external_ip = None
        soap_body, headers = build_soap("GetExternalIPAddress", service_type, [])
        status, response = http.post(control_url, soap_body, headers, max(0.5, deadline - clock()))
        if status == 200:
            external_ip = parse_external_ip(response.decode("utf-8", "replace"))
        if external_ip and is_private_address(external_ip):
            external_ip = None

        for attempt in range(UPNP_PORT_ATTEMPTS):
            if clock() >= deadline:
                return None
            external_port = port + attempt
            soap_body, headers = build_soap(
                "AddPortMapping",
                service_type,
                [
                    ("NewRemoteHost", ""),
                    ("NewExternalPort", str(external_port)),
                    ("NewProtocol", "TCP"),
                    ("NewInternalPort", str(port)),
                    ("NewInternalClient", local_ip),
                    ("NewEnabled", "1"),
                    ("NewPortMappingDescription", UPNP_DESCRIPTION),
                    ("NewLeaseDuration", str(LEASE_SECONDS)),
                ],
            )
            status, response = http.post(control_url, soap_body, headers, max(0.5, deadline - clock()))
            if status == 200:
                return Mapping(
                    method="upnp",
                    external_ip=external_ip,
                    external_port=external_port,
                    internal_port=port,
                    lifetime=LEASE_SECONDS,
                    gateway=gateway,
                    control_url=control_url,
                    service_type=service_type,
                )
            if parse_soap_error(response.decode("utf-8", "replace")) == UPNP_CONFLICT_ERROR:
                continue
            break
    return None


def map_port(
    *,
    port: int,
    deadline_seconds: float = MAP_DEADLINE_SECONDS,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
    gateway: Optional[str] = None,
    detect: Callable[[], Optional[str]] = detect_gateway,
    udp: Optional[UdpTransport] = None,
    http: Optional[HttpTransport] = None,
    ssdp: Optional[SsdpTransport] = None,
    local_ip: Optional[str] = None,
) -> Optional[Mapping]:
    """跟路由器要一個對外 TCP 埠：NAT-PMP 優先，沒回應改 UPnP IGD。整體上限
    `deadline_seconds`（預設 8 秒，Global Constraints）。成功回 `Mapping`；
    任何失敗（找不到閘道、兩者都沒回應、逾時、例外）一律回 None —— 呼叫端
    退回區網位址並記一行 WARNING（spec §3.1 第 4 點）。

    每一個副作用都可注入：`detect`（預設 `detect_gateway`，會跑 `route` 指令）
    與三個 transport，所以單元測試不必碰真的路由表或真的 socket。

    BLOCKING：呼叫端必須包在 `asyncio.to_thread` 裡。"""
    deadline = clock() + deadline_seconds
    try:
        gateway = gateway or detect()
        if not gateway:
            logger.info("natmap: no default gateway found; skipping automatic port mapping")
            return None

        udp = udp or _SocketUdpTransport()
        http = http or _UrllibHttpTransport()
        ssdp = ssdp or _MulticastSsdpTransport()
        if local_ip is None:
            from comfyfed_agent import peerserve

            local_ip = peerserve._detect_local_ip()

        mapping = _try_natpmp(
            gateway=gateway, port=port, udp=udp, clock=clock, sleep=sleep, deadline=deadline
        )
        if mapping is not None:
            return mapping

        return _try_upnp(
            gateway=gateway,
            port=port,
            local_ip=local_ip,
            http=http,
            ssdp=ssdp,
            clock=clock,
            deadline=deadline,
        )
    except Exception:
        logger.exception("natmap: automatic port mapping failed unexpectedly")
        return None


def unmap_port(
    mapping: Mapping,
    *,
    udp: Optional[UdpTransport] = None,
    http: Optional[HttpTransport] = None,
    timeout: float = 2.0,
) -> None:
    """釋放一筆映射（NAT-PMP lifetime 0 / UPnP DeletePortMapping）。盡力而為：
    失敗只記 debug —— agent 要關了，lease 3600 秒也會自己過期。"""
    try:
        if mapping.method == "natpmp":
            transport = udp or _SocketUdpTransport()
            transport.exchange(
                mapping.gateway,
                NATPMP_PORT,
                encode_natpmp_request(
                    2,
                    internal_port=mapping.internal_port,
                    external_port=mapping.external_port,
                    lifetime=0,
                ),
                timeout,
            )
            return
        if mapping.method == "upnp" and mapping.control_url and mapping.service_type:
            transport = http or _UrllibHttpTransport()
            body, headers = build_soap(
                "DeletePortMapping",
                mapping.service_type,
                [
                    ("NewRemoteHost", ""),
                    ("NewExternalPort", str(mapping.external_port)),
                    ("NewProtocol", "TCP"),
                ],
            )
            transport.post(mapping.control_url, body, headers, timeout)
    except Exception:
        logger.debug("natmap: releasing the port mapping failed (ignored)", exc_info=True)
