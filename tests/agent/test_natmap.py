"""Phase 3.4 natmap：閘道解析、NAT-PMP 封包、SSDP/SOAP 解析、map_port
協調器。全部以 fake transport + fake clock 驅動，絕不碰真的路由器。"""

from __future__ import annotations

import struct

import pytest

from comfyfed_agent import natmap

WINDOWS_ROUTE = """IPv4 Route Table
===========================================================================
Active Routes:
Network Destination        Netmask          Gateway       Interface  Metric
          0.0.0.0          0.0.0.0      192.168.1.1     192.168.1.5     35
        127.0.0.0        255.0.0.0         On-link         127.0.0.1    331
===========================================================================
"""

MACOS_ROUTE = """   route to: default
destination: default
    gateway: 192.168.0.1
  interface: en0
"""

LINUX_IP_ROUTE = "default via 10.0.0.1 dev eth0 proto dhcp src 10.0.0.23 metric 100 \n"


def test_parse_windows_route_finds_default_gateway():
    assert natmap.parse_windows_route(WINDOWS_ROUTE) == "192.168.1.1"


def test_parse_windows_route_returns_none_without_a_default_row():
    assert natmap.parse_windows_route("Active Routes:\n  10.0.0.0  255.0.0.0  On-link  10.0.0.5  1\n") is None


def test_parse_macos_route_finds_gateway():
    assert natmap.parse_macos_route(MACOS_ROUTE) == "192.168.0.1"


def test_parse_macos_route_returns_none_when_not_found():
    assert natmap.parse_macos_route("route: writing to routing socket: not in table\n") is None


def test_parse_macos_route_rejects_a_non_ip_gateway():
    # 直連的介面會印 `gateway: link#8`，那不是可以送 NAT-PMP 的位址。
    assert natmap.parse_macos_route("    gateway: link#8\n") is None


def test_parse_linux_ip_route_rejects_a_non_ip_token():
    assert natmap.parse_linux_ip_route("default via dev eth0 proto kernel\n") is None


def test_parse_linux_ip_route_finds_via():
    assert natmap.parse_linux_ip_route(LINUX_IP_ROUTE) == "10.0.0.1"


def test_parse_linux_ip_route_returns_none_when_empty():
    assert natmap.parse_linux_ip_route("") is None


def test_detect_gateway_dispatches_per_platform():
    calls: list[list[str]] = []

    def runner(argv):
        calls.append(argv)
        return LINUX_IP_ROUTE

    assert natmap.detect_gateway(platform_name="linux", runner=runner) == "10.0.0.1"
    assert calls == [["ip", "route", "show", "default"]]


def test_detect_gateway_returns_none_when_the_command_fails():
    def runner(argv):
        raise OSError("command not found")

    assert natmap.detect_gateway(platform_name="darwin", runner=runner) is None


@pytest.mark.parametrize(
    "host,private",
    [
        ("10.0.0.1", True),
        ("172.16.5.4", True),
        ("172.32.5.4", False),
        ("192.168.1.5", True),
        ("169.254.10.2", True),
        ("100.64.3.9", True),  # RFC 6598 CGNAT：電信商級 NAT，一樣連不到
        ("100.128.0.1", False),
        ("127.0.0.1", True),
        ("::1", True),
        ("fc00::1", True),
        ("fd12:3456::1", True),
        ("203.0.113.7", False),
        ("2001:db8::1", False),
        ("not-an-ip", False),
    ],
)
def test_is_private_address(host, private):
    assert natmap.is_private_address(host) is private


def test_encode_natpmp_external_address_request():
    assert natmap.encode_natpmp_request(0) == b"\x00\x00"


def test_encode_natpmp_mapping_request_is_rfc6886_shaped():
    payload = natmap.encode_natpmp_request(2, internal_port=8850, external_port=8850, lifetime=3600)
    assert len(payload) == 12
    version, opcode, reserved, internal, external, lifetime = struct.unpack("!BBHHHI", payload)
    assert (version, opcode, reserved) == (0, 2, 0)
    assert (internal, external, lifetime) == (8850, 8850, 3600)


def test_decode_natpmp_external_address_response():
    data = struct.pack("!BBHI", 0, 128, 0, 1234) + bytes([203, 0, 113, 7])
    assert natmap.decode_natpmp_response(data) == {
        "opcode": 128,
        "result": 0,
        "epoch": 1234,
        "external_ip": "203.0.113.7",
    }


def test_decode_natpmp_mapping_response_uses_the_returned_external_port():
    data = struct.pack("!BBHIHHI", 0, 130, 0, 99, 8850, 9001, 3600)
    decoded = natmap.decode_natpmp_response(data)
    assert decoded["opcode"] == 130
    assert decoded["result"] == 0
    assert decoded["internal_port"] == 8850
    assert decoded["external_port"] == 9001
    assert decoded["lifetime"] == 3600


def test_decode_natpmp_keeps_a_nonzero_result_code():
    data = struct.pack("!BBHIHHI", 0, 130, 3, 99, 8850, 8850, 0)
    assert natmap.decode_natpmp_response(data)["result"] == 3


def test_decode_natpmp_rejects_a_truncated_datagram():
    assert natmap.decode_natpmp_response(b"\x00\x82\x00") is None


SSDP_RESPONSE = (
    b"HTTP/1.1 200 OK\r\n"
    b"CACHE-CONTROL: max-age=1800\r\n"
    b"ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n"
    b"location: http://192.168.1.1:5000/rootDesc.xml\r\n"
    b"\r\n"
)

IGD_XML = """<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <device>
    <deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType>
    <deviceList>
      <device>
        <serviceList>
          <service>
            <serviceType>urn:schemas-upnp-org:service:WANCommonInterfaceConfig:1</serviceType>
            <controlURL>/ctl/CommonIfCfg</controlURL>
          </service>
        </serviceList>
        <deviceList>
          <device>
            <serviceList>
              <service>
                <serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>
                <controlURL>/ctl/IPConn</controlURL>
              </service>
            </serviceList>
          </device>
        </deviceList>
      </device>
    </deviceList>
  </device>
</root>
"""

IGD_XML_PPP_ONLY = IGD_XML.replace("WANIPConnection:1", "WANPPPConnection:1").replace(
    "/ctl/IPConn", "/ctl/PPPConn"
)
IGD_XML_V2 = IGD_XML.replace("WANIPConnection:1", "WANIPConnection:2")
IGD_XML_PPP_V2 = IGD_XML.replace("WANIPConnection:1", "WANPPPConnection:2").replace(
    "/ctl/IPConn", "/ctl/PPPConn"
)

EXTERNAL_IP_RESPONSE = """<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
<s:Body><u:GetExternalIPAddressResponse xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1">
<NewExternalIPAddress>203.0.113.7</NewExternalIPAddress>
</u:GetExternalIPAddressResponse></s:Body></s:Envelope>
"""

CONFLICT_RESPONSE = """<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
<s:Body><s:Fault><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0">
<errorCode>718</errorCode><errorDescription>ConflictInMappingEntry</errorDescription>
</UPnPError></detail></s:Fault></s:Body></s:Envelope>
"""

ADD_OK_RESPONSE = """<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
<s:Body><u:AddPortMappingResponse xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1"/>
</s:Body></s:Envelope>
"""


def test_service_type_preference_order_is_ip1_ppp1_ip2_ppp2():
    assert natmap._SERVICE_TYPES == (
        "urn:schemas-upnp-org:service:WANIPConnection:1",
        "urn:schemas-upnp-org:service:WANPPPConnection:1",
        "urn:schemas-upnp-org:service:WANIPConnection:2",
        "urn:schemas-upnp-org:service:WANPPPConnection:2",
    )


def test_parse_ssdp_locations_is_case_insensitive_and_deduped():
    assert natmap.parse_ssdp_locations([SSDP_RESPONSE, SSDP_RESPONSE]) == [
        "http://192.168.1.1:5000/rootDesc.xml"
    ]


def test_parse_ssdp_locations_ignores_datagrams_without_a_location():
    assert natmap.parse_ssdp_locations([b"HTTP/1.1 200 OK\r\n\r\n"]) == []


def test_find_control_url_prefers_wanipconnection_v1():
    assert natmap.find_control_url(IGD_XML, "http://192.168.1.1:5000/rootDesc.xml") == (
        "http://192.168.1.1:5000/ctl/IPConn",
        "urn:schemas-upnp-org:service:WANIPConnection:1",
    )


def test_find_control_url_falls_back_to_wanppp_then_v2():
    assert natmap.find_control_url(IGD_XML_PPP_ONLY, "http://192.168.1.1:5000/rootDesc.xml") == (
        "http://192.168.1.1:5000/ctl/PPPConn",
        "urn:schemas-upnp-org:service:WANPPPConnection:1",
    )
    assert natmap.find_control_url(IGD_XML_V2, "http://192.168.1.1:5000/rootDesc.xml") == (
        "http://192.168.1.1:5000/ctl/IPConn",
        "urn:schemas-upnp-org:service:WANIPConnection:2",
    )
    assert natmap.find_control_url(IGD_XML_PPP_V2, "http://192.168.1.1:5000/rootDesc.xml") == (
        "http://192.168.1.1:5000/ctl/PPPConn",
        "urn:schemas-upnp-org:service:WANPPPConnection:2",
    )


def test_find_control_url_returns_none_without_a_wan_connection_service():
    assert natmap.find_control_url("<root></root>", "http://192.168.1.1:5000/rootDesc.xml") is None


def test_build_soap_has_the_action_envelope_and_soapaction_header():
    body, headers = natmap.build_soap(
        "AddPortMapping",
        "urn:schemas-upnp-org:service:WANIPConnection:1",
        [("NewRemoteHost", ""), ("NewExternalPort", "8850"), ("NewProtocol", "TCP")],
    )
    text = body.decode()
    assert '<u:AddPortMapping xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1">' in text
    assert "<NewRemoteHost></NewRemoteHost>" in text
    assert "<NewExternalPort>8850</NewExternalPort>" in text
    assert headers["SOAPAction"] == '"urn:schemas-upnp-org:service:WANIPConnection:1#AddPortMapping"'
    assert headers["Content-Type"] == 'text/xml; charset="utf-8"'


def test_find_control_url_honours_urlbase():
    """有些 IGD 的控制端點跟描述檔不同埠，靠 `<URLBase>` 宣告。"""
    xml = IGD_XML.replace(
        "<device>", "<URLBase>http://192.168.1.1:49152/</URLBase>\n  <device>", 1
    )
    assert natmap.find_control_url(xml, "http://192.168.1.1:5000/rootDesc.xml") == (
        "http://192.168.1.1:49152/ctl/IPConn",
        "urn:schemas-upnp-org:service:WANIPConnection:1",
    )


def test_parse_external_ip_and_soap_error():
    assert natmap.parse_external_ip(EXTERNAL_IP_RESPONSE) == "203.0.113.7"
    assert natmap.parse_soap_error(CONFLICT_RESPONSE) == 718
    assert natmap.parse_soap_error(ADD_OK_RESPONSE) is None


def test_parse_external_ip_rejects_a_non_ip_value():
    assert natmap.parse_external_ip(
        EXTERNAL_IP_RESPONSE.replace("203.0.113.7", "not-an-ip")
    ) is None
    assert natmap.parse_external_ip(EXTERNAL_IP_RESPONSE.replace("203.0.113.7", "")) is None


def test_soap_parsers_tolerate_a_namespace_prefix():
    assert natmap.parse_soap_error(
        CONFLICT_RESPONSE.replace("errorCode>", "e:errorCode>")
    ) == 718
    assert natmap.parse_external_ip(
        EXTERNAL_IP_RESPONSE.replace("NewExternalIPAddress>", "u:NewExternalIPAddress>")
    ) == "203.0.113.7"


class FakeClock:
    """單調時鐘：sleep 只推進時間，不真的睡。"""

    def __init__(self) -> None:
        self.now = 0.0
        self.sleeps: list[float] = []

    def time(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


class FakeUdp:
    """replies 依序取用（None = 逾時）；每次 exchange 讓時鐘前進 cost
    秒，好讓 8 秒上限測得出來。真的 socket 不會超過自己的 timeout，
    所以這裡也只前進 min(cost, timeout)。"""

    def __init__(self, replies, clock: FakeClock, cost: float = 0.0) -> None:
        self.replies = list(replies)
        self.clock = clock
        self.cost = cost
        self.sent: list[tuple[str, int, bytes]] = []
        self.timeouts: list[float] = []

    def exchange(self, host, port, payload, timeout):
        self.sent.append((host, port, payload))
        self.timeouts.append(timeout)
        self.clock.now += min(self.cost, timeout)
        return self.replies.pop(0) if self.replies else None


class FakeHttp:
    def __init__(self, get_map=None, post_responses=None, clock=None, cost=0.0) -> None:
        self.get_map = get_map or {}
        self.post_responses = list(post_responses or [])
        self.clock = clock
        self.cost = cost
        self.posts: list[tuple[str, bytes, dict]] = []

    def get(self, url, timeout):
        if self.clock:
            self.clock.now += self.cost
        body = self.get_map.get(url)
        return (200, body.encode()) if body is not None else (404, b"")

    def post(self, url, body, headers, timeout):
        self.posts.append((url, body, headers))
        if self.clock:
            self.clock.now += self.cost
        return self.post_responses.pop(0) if self.post_responses else (500, b"")


class FakeSsdp:
    def __init__(self, datagrams, clock: FakeClock) -> None:
        self.datagrams = list(datagrams)
        self.clock = clock
        self.waited: list[float] = []

    def msearch(self, payload, wait_seconds):
        self.waited.append(wait_seconds)
        self.clock.now += wait_seconds
        return list(self.datagrams)


def _no_gateway():
    """注入用的閘道偵測假物件：測試絕不碰真的路由表。"""
    return None


def _natpmp_external_ip_reply(ip=(203, 0, 113, 7)):
    return struct.pack("!BBHI", 0, 128, 0, 1) + bytes(ip)


def _natpmp_mapping_reply(external_port=8850, lifetime=3600, result=0):
    return struct.pack("!BBHIHHI", 0, 130, result, 1, 8850, external_port, lifetime)


def _map(
    clock,
    *,
    udp,
    http=None,
    ssdp=None,
    gateway="192.168.1.1",
    port=8850,
    detect=_no_gateway,
    deadline_seconds=natmap.MAP_DEADLINE_SECONDS,
):
    return natmap.map_port(
        port=port,
        deadline_seconds=deadline_seconds,
        clock=clock.time,
        sleep=clock.sleep,
        gateway=gateway,
        detect=detect,
        udp=udp,
        http=http if http is not None else FakeHttp(),
        ssdp=ssdp if ssdp is not None else FakeSsdp([], clock),
        local_ip="192.168.1.5",
    )


def test_map_port_uses_natpmp_first_and_returns_the_reported_external_port():
    clock = FakeClock()
    udp = FakeUdp([_natpmp_external_ip_reply(), _natpmp_mapping_reply(external_port=9001)], clock)

    mapping = _map(clock, udp=udp)

    assert mapping is not None
    assert mapping.method == "natpmp"
    assert mapping.external_ip == "203.0.113.7"
    assert mapping.external_port == 9001
    assert mapping.internal_port == 8850
    assert mapping.lifetime == 3600
    assert udp.sent[1][2] == natmap.encode_natpmp_request(
        2, internal_port=8850, external_port=8850, lifetime=3600
    )


def test_map_port_natpmp_retries_250ms_doubling_at_most_three_times():
    clock = FakeClock()
    udp = FakeUdp([None, None, None], clock)

    _map(clock, udp=udp)

    assert len(udp.sent) == 3
    assert udp.timeouts == [0.25, 0.5, 1.0]
    # 最後一次送完不再睡：剩下的預算要留給 UPnP。
    assert clock.sleeps == [0.25, 0.5]


def test_map_port_natpmp_succeeds_on_the_second_attempt():
    clock = FakeClock()
    udp = FakeUdp(
        [None, _natpmp_external_ip_reply(), None, _natpmp_mapping_reply()],
        clock,
    )

    mapping = _map(clock, udp=udp)

    assert mapping is not None
    assert mapping.method == "natpmp"
    assert len(udp.sent) == 4
    assert clock.sleeps == [0.25, 0.25]  # 每一輪各重送一次


def test_map_port_ignores_a_reply_with_the_wrong_opcode_or_version():
    clock = FakeClock()
    stray = struct.pack("!BBHI", 1, 129, 0, 1) + bytes((203, 0, 113, 7))  # 版本 1、opcode 129
    udp = FakeUdp([stray, stray, stray], clock)

    assert _map(clock, udp=udp) is None
    assert len(udp.sent) == 3  # 三次都當作沒收到，重送滿


def test_map_port_falls_through_to_upnp_when_natpmp_answers_with_an_error():
    clock = FakeClock()
    location = "http://192.168.1.1:5000/rootDesc.xml"
    refused = struct.pack("!BBHI", 0, 128, 3, 1) + bytes((0, 0, 0, 0))  # result 3
    http = FakeHttp(
        get_map={location: IGD_XML},
        post_responses=[(200, EXTERNAL_IP_RESPONSE.encode()), (200, ADD_OK_RESPONSE.encode())],
        clock=clock,
    )

    mapping = _map(
        clock,
        udp=FakeUdp([refused], clock),
        http=http,
        ssdp=FakeSsdp([SSDP_RESPONSE], clock),
    )

    assert mapping is not None
    assert mapping.method == "upnp"


def test_map_port_falls_back_to_upnp_when_natpmp_is_silent():
    clock = FakeClock()
    location = "http://192.168.1.1:5000/rootDesc.xml"
    http = FakeHttp(
        get_map={location: IGD_XML},
        post_responses=[(200, EXTERNAL_IP_RESPONSE.encode()), (200, ADD_OK_RESPONSE.encode())],
        clock=clock,
    )

    mapping = _map(clock, udp=FakeUdp([None, None, None], clock), http=http, ssdp=FakeSsdp([SSDP_RESPONSE], clock))

    assert mapping is not None
    assert mapping.method == "upnp"
    assert mapping.external_ip == "203.0.113.7"
    assert mapping.external_port == 8850
    assert mapping.control_url == "http://192.168.1.1:5000/ctl/IPConn"
    add_body = http.posts[-1][1].decode()
    assert "<NewInternalClient>192.168.1.5</NewInternalClient>" in add_body
    assert "<NewLeaseDuration>3600</NewLeaseDuration>" in add_body
    assert "<NewPortMappingDescription>ComfyFed peer</NewPortMappingDescription>" in add_body


def test_map_port_upnp_718_conflict_walks_the_external_port_up():
    clock = FakeClock()
    location = "http://192.168.1.1:5000/rootDesc.xml"
    conflict = (500, CONFLICT_RESPONSE.encode())
    http = FakeHttp(
        get_map={location: IGD_XML},
        post_responses=[
            (200, EXTERNAL_IP_RESPONSE.encode()),
            conflict,
            conflict,
            (200, ADD_OK_RESPONSE.encode()),
        ],
        clock=clock,
    )

    mapping = _map(clock, udp=FakeUdp([None, None, None], clock), http=http, ssdp=FakeSsdp([SSDP_RESPONSE], clock))

    assert mapping is not None
    assert mapping.external_port == 8852  # 8850 衝突、8851 衝突、8852 成功


def test_map_port_gives_up_after_five_conflicting_ports():
    clock = FakeClock()
    location = "http://192.168.1.1:5000/rootDesc.xml"
    conflict = (500, CONFLICT_RESPONSE.encode())
    http = FakeHttp(
        get_map={location: IGD_XML},
        post_responses=[(200, EXTERNAL_IP_RESPONSE.encode())] + [conflict] * 5,
        clock=clock,
    )

    mapping = _map(clock, udp=FakeUdp([None, None, None], clock), http=http, ssdp=FakeSsdp([SSDP_RESPONSE], clock))

    assert mapping is None


def test_map_port_respects_the_eight_second_cap():
    """每一步都吃滿自己的逾時（沒回應的路由器）也不准超過 8 秒：
    NAT-PMP 兩輪重送、SSDP 等 2.5 秒、再抓一次裝置描述就沒預算了。"""
    clock = FakeClock()
    location = "http://192.168.1.1:5000/rootDesc.xml"
    udp = FakeUdp([None, None, None], clock, cost=10.0)
    ssdp = FakeSsdp([SSDP_RESPONSE], clock)
    http = FakeHttp(get_map={location: IGD_XML}, clock=clock, cost=3.0)

    mapping = _map(clock, udp=udp, http=http, ssdp=ssdp)

    assert mapping is None
    assert clock.now <= natmap.MAP_DEADLINE_SECONDS
    assert http.posts == []  # 預算用完，連 SOAP 都沒送出去


def test_map_port_skips_upnp_when_there_is_no_time_left_for_ssdp():
    """剩下的時間不夠 SSDP 等滿 2.5 秒 ⇒ 根本不開始（不然一定超時）。"""
    clock = FakeClock()
    udp = FakeUdp([None, None, None], clock, cost=10.0)
    ssdp = FakeSsdp([SSDP_RESPONSE], clock)

    mapping = _map(clock, udp=udp, http=FakeHttp(get_map={}), ssdp=ssdp, deadline_seconds=3.0)

    assert mapping is None
    assert ssdp.waited == []  # 逾時了，SSDP 根本沒開始
    assert clock.now <= 3.0


def test_map_port_without_a_gateway_returns_none_and_sends_nothing():
    clock = FakeClock()
    udp = FakeUdp([_natpmp_external_ip_reply()], clock)

    assert _map(clock, udp=udp, gateway=None, detect=_no_gateway) is None
    assert udp.sent == []


def test_map_port_detects_the_gateway_when_the_caller_does_not_pass_one():
    clock = FakeClock()
    udp = FakeUdp([_natpmp_external_ip_reply(), _natpmp_mapping_reply()], clock)

    mapping = _map(clock, udp=udp, gateway=None, detect=lambda: "192.168.9.1")

    assert mapping is not None
    assert mapping.gateway == "192.168.9.1"
    assert udp.sent[0][0] == "192.168.9.1"


def test_map_port_binds_the_default_ssdp_transport_to_the_local_ip(monkeypatch):
    """多網卡的機器要從 peer server 那張網卡送 M-SEARCH，不然路由器收不到。"""
    built: list = []

    class RecordingSsdp:
        def __init__(self, local_ip=None):
            self.local_ip = local_ip
            built.append(self)

        def msearch(self, payload, wait_seconds):
            return []

    monkeypatch.setattr(natmap, "_MulticastSsdpTransport", RecordingSsdp)
    clock = FakeClock()

    assert (
        natmap.map_port(
            port=8850,
            clock=clock.time,
            sleep=clock.sleep,
            gateway="192.168.1.1",
            detect=_no_gateway,
            udp=FakeUdp([None, None, None], clock),
            http=FakeHttp(),
            local_ip="192.168.1.5",
        )
        is None
    )
    assert [transport.local_ip for transport in built] == ["192.168.1.5"]


def test_map_port_keeps_a_private_external_ip_as_none_for_the_caller_to_replace():
    """雙層 NAT：路由器回報的外部 IP 還是私有位址 ⇒ external_ip = None，
    呼叫端改用平台回報的 remote_ip（spec §3.1 第 5 點）。"""
    clock = FakeClock()
    udp = FakeUdp([_natpmp_external_ip_reply(ip=(192, 168, 100, 1)), _natpmp_mapping_reply()], clock)

    mapping = _map(clock, udp=udp)

    assert mapping is not None
    assert mapping.external_ip is None


def test_map_port_swallows_a_transport_exception():
    class BoomUdp:
        def __init__(self) -> None:
            self.sent: list = []

        def exchange(self, host, port, payload, timeout):
            raise RuntimeError("boom")

    clock = FakeClock()
    assert _map(clock, udp=BoomUdp()) is None


def test_unmap_port_sends_a_zero_lifetime_natpmp_request():
    clock = FakeClock()
    udp = FakeUdp([_natpmp_mapping_reply(lifetime=0)], clock)
    mapping = natmap.Mapping(
        method="natpmp",
        external_ip="203.0.113.7",
        external_port=8850,
        internal_port=8850,
        lifetime=3600,
        gateway="192.168.1.1",
    )

    natmap.unmap_port(mapping, udp=udp)

    # RFC 6886 §3.4：刪除時 external port 送 0（路由器用 internal port 找映射）。
    assert udp.sent[0][2] == natmap.encode_natpmp_request(
        2, internal_port=8850, external_port=0, lifetime=0
    )


def test_unmap_port_sends_deleteportmapping_for_upnp():
    http = FakeHttp(post_responses=[(200, ADD_OK_RESPONSE.encode())])
    mapping = natmap.Mapping(
        method="upnp",
        external_ip="203.0.113.7",
        external_port=8852,
        internal_port=8850,
        lifetime=3600,
        gateway="192.168.1.1",
        control_url="http://192.168.1.1:5000/ctl/IPConn",
        service_type="urn:schemas-upnp-org:service:WANIPConnection:1",
    )

    natmap.unmap_port(mapping, http=http)

    url, body, headers = http.posts[0]
    assert url == "http://192.168.1.1:5000/ctl/IPConn"
    assert "DeletePortMapping" in headers["SOAPAction"]
    assert "<NewExternalPort>8852</NewExternalPort>" in body.decode()
