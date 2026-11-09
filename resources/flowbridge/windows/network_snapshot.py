"""Read-only Windows IP Helper snapshots; no shell, DNS or network writes.

Windows SDK structures use fixed widths and default (not packed) alignment.
Definitions were checked against Microsoft's WinSDK headers and Learn pages:
https://github.com/microsoft/win32metadata/blob/main/generation/WinSDK/RecompiledIdlHeaders/shared/netioapi.h
https://learn.microsoft.com/windows/win32/api/netioapi/nf-netioapi-getiftable2
https://learn.microsoft.com/windows/win32/api/netioapi/nf-netioapi-getipforwardtable2
https://learn.microsoft.com/windows/win32/api/netioapi/nf-netioapi-getipinterfacetable
https://learn.microsoft.com/windows/win32/api/netioapi/nf-netioapi-getunicastipaddresstable

Native calls are synchronous: a deadline is checked around each call, but it
cannot interrupt a Windows API call. Each API owns its allocation until the
finally block releases it; all returned rows are independent copies.
"""

from __future__ import annotations

import ctypes as c
import ipaddress
import math
import os
import time


U8, U16, U32, U64 = c.c_uint8, c.c_uint16, c.c_uint32, c.c_uint64
I32, I64 = c.c_int32, c.c_int64
AF_UNSPEC, AF_INET, AF_INET6 = 0, 2, 23  # Windows values, including on test hosts.
INTERFACE_NAME = 'modeldock-net'
_MAX_ROWS = 1_000_000
# sing-tun 040db71fcd33 (bundled by sing-box 1.14.4) derives its adapter GUID
# from the raw MD5 bytes of b'wintun' + the interface name. This is an identity
# match, not an authentication primitive. Unknown adapters stay conflicts.
_TUN_GUID_BYTES = bytes.fromhex('a06b37bf2b0eaf495c0c5c1e40009762')
_TUN_DESCRIPTION = tuple(map(ord, 'sing-tun Tunnel')) + (0,)


class GUID(c.Structure):
    _fields_ = [('Data1', U32), ('Data2', U16), ('Data3', U16), ('Data4', U8 * 8)]


class IN_ADDR(c.Union):
    _fields_ = [('Bytes', U8 * 4), ('Value', U32)]


class SOCKADDR_IN(c.Structure):
    _fields_ = [('Family', U16), ('Port', U16), ('Address', IN_ADDR), ('Zero', U8 * 8)]


class SOCKADDR_IN6(c.Structure):
    _fields_ = [('Family', U16), ('Port', U16), ('FlowInfo', U32),
                ('Address', U8 * 16), ('ScopeId', U32)]


class SOCKADDR_INET(c.Union):
    _fields_ = [('Ipv4', SOCKADDR_IN), ('Ipv6', SOCKADDR_IN6), ('Family', U16)]


class IP_ADDRESS_PREFIX(c.Structure):
    _fields_ = [('Prefix', SOCKADDR_INET), ('PrefixLength', U8)]


class MIB_IF_ROW2(c.Structure):
    _fields_ = [
        ('InterfaceLuid', U64), ('InterfaceIndex', U32), ('InterfaceGuid', GUID),
        ('Alias', U16 * 257), ('Description', U16 * 257),
        ('PhysicalAddressLength', U32), ('PhysicalAddress', U8 * 32), ('PermanentPhysicalAddress', U8 * 32),
        ('Mtu', U32), ('Type', U32), ('TunnelType', I32), ('MediaType', I32),
        ('PhysicalMediumType', I32), ('AccessType', I32), ('DirectionType', I32),
        ('InterfaceAndOperStatusFlags', U8), ('OperStatus', I32), ('AdminStatus', I32),
        ('MediaConnectState', I32), ('NetworkGuid', GUID), ('ConnectionType', I32),
    ] + [(name, U64) for name in (
        'TransmitLinkSpeed', 'ReceiveLinkSpeed', 'InOctets', 'InUcastPkts', 'InNUcastPkts',
        'InDiscards', 'InErrors', 'InUnknownProtos', 'InUcastOctets', 'InMulticastOctets',
        'InBroadcastOctets', 'OutOctets', 'OutUcastPkts', 'OutNUcastPkts', 'OutDiscards',
        'OutErrors', 'OutUcastOctets', 'OutMulticastOctets', 'OutBroadcastOctets', 'OutQLen')]


class MIB_IPINTERFACE_ROW(c.Structure):
    _fields_ = [
        ('Family', U16), ('InterfaceLuid', U64), ('InterfaceIndex', U32),
        ('MaxReassemblySize', U32), ('InterfaceIdentifier', U64),
        ('MinRouterAdvertisementInterval', U32), ('MaxRouterAdvertisementInterval', U32),
    ] + [(name, U8) for name in (
        'AdvertisingEnabled', 'ForwardingEnabled', 'WeakHostSend', 'WeakHostReceive',
        'UseAutomaticMetric', 'UseNeighborUnreachabilityDetection',
        'ManagedAddressConfigurationSupported', 'OtherStatefulConfigurationSupported', 'AdvertiseDefaultRoute')
    ] + [
        ('RouterDiscoveryBehavior', I32), ('DadTransmits', U32), ('BaseReachableTime', U32),
        ('RetransmitTime', U32), ('PathMtuDiscoveryTimeout', U32), ('LinkLocalAddressBehavior', I32),
        ('LinkLocalAddressTimeout', U32), ('ZoneIndices', U32 * 16),
        ('SitePrefixLength', U32), ('Metric', U32), ('NlMtu', U32),
        ('Connected', U8), ('SupportsWakeUpPatterns', U8), ('SupportsNeighborDiscovery', U8),
        ('SupportsRouterDiscovery', U8), ('ReachableTime', U32),
        # NL_INTERFACE_OFFLOAD_ROD consists of eight BOOLEAN bitfields (1 byte).
        ('TransmitOffload', U8), ('ReceiveOffload', U8), ('DisableDefaultRoutes', U8),
    ]


class MIB_IPFORWARD_ROW2(c.Structure):
    _fields_ = [
        ('InterfaceLuid', U64), ('InterfaceIndex', U32), ('DestinationPrefix', IP_ADDRESS_PREFIX),
        ('NextHop', SOCKADDR_INET), ('SitePrefixLength', U8), ('ValidLifetime', U32),
        ('PreferredLifetime', U32), ('Metric', U32), ('Protocol', I32),
        ('Loopback', U8), ('AutoconfigureAddress', U8), ('Publish', U8), ('Immortal', U8),
        ('Age', U32), ('Origin', I32),
    ]


class MIB_UNICASTIPADDRESS_ROW(c.Structure):
    _fields_ = [
        ('Address', SOCKADDR_INET), ('InterfaceLuid', U64), ('InterfaceIndex', U32),
        ('PrefixOrigin', I32), ('SuffixOrigin', I32), ('ValidLifetime', U32),
        ('PreferredLifetime', U32), ('OnLinkPrefixLength', U8), ('SkipAsSource', U8),
        ('DadState', I32), ('ScopeId', U32), ('CreationTimeStamp', I64),
    ]


def _table_type(name, row):
    return type(name, (c.Structure,), {'_fields_': [('NumEntries', U32), ('Table', row * 1)]})


MIB_IF_TABLE2 = _table_type('MIB_IF_TABLE2', MIB_IF_ROW2)
MIB_IPINTERFACE_TABLE = _table_type('MIB_IPINTERFACE_TABLE', MIB_IPINTERFACE_ROW)
MIB_IPFORWARD_TABLE2 = _table_type('MIB_IPFORWARD_TABLE2', MIB_IPFORWARD_ROW2)
MIB_UNICASTIPADDRESS_TABLE = _table_type('MIB_UNICASTIPADDRESS_TABLE', MIB_UNICASTIPADDRESS_ROW)
_TABLES = {
    'GetIfTable2': (MIB_IF_TABLE2, MIB_IF_ROW2),
    'GetIpInterfaceTable': (MIB_IPINTERFACE_TABLE, MIB_IPINTERFACE_ROW),
    'GetIpForwardTable2': (MIB_IPFORWARD_TABLE2, MIB_IPFORWARD_ROW2),
    'GetUnicastIpAddressTable': (MIB_UNICASTIPADDRESS_TABLE, MIB_UNICASTIPADDRESS_ROW),
}


def _api():
    if os.name != 'nt':
        raise OSError('此功能仅支持 Windows。')
    api = c.WinDLL('iphlpapi', use_last_error=True)
    for name, (table, _) in _TABLES.items():
        function = getattr(api, name)
        function.argtypes = ([] if name == 'GetIfTable2' else [U16]) + [c.POINTER(c.POINTER(table))]
        function.restype = U32
    api.FreeMibTable.argtypes = [c.c_void_p]
    api.FreeMibTable.restype = None
    return api


def _check_deadline(deadline):
    if deadline is not None and time.monotonic() >= deadline:
        raise TimeoutError('读取 Windows 网络状态超时。')


def _read_table(api, name, deadline=None):
    _check_deadline(deadline)
    table_type, row_type = _TABLES[name]
    pointer = c.POINTER(table_type)()
    try:
        arguments = (() if name == 'GetIfTable2' else (AF_UNSPEC,)) + (c.byref(pointer),)
        status = getattr(api, name)(*arguments)
        if status:
            raise OSError(f'无法读取 Windows 网络状态（{name} 错误 {status}）。')
        if not pointer:
            raise OSError('Windows 网络状态表为空指针。')
        _check_deadline(deadline)
        count = pointer.contents.NumEntries
        if count > _MAX_ROWS:
            raise OSError('Windows 网络状态表记录数异常。')
        base, stride = c.addressof(pointer.contents) + table_type.Table.offset, c.sizeof(row_type)
        rows = [row_type.from_buffer_copy(c.string_at(base + index * stride, stride)) for index in range(count)]
        _check_deadline(deadline)
        return rows
    finally:
        if pointer:
            api.FreeMibTable(pointer)


def _alias_text(row):
    units = list(row.Alias)
    try:
        end = units.index(0)
    except ValueError:
        raise OSError('Windows 网卡名称无效。') from None
    try:
        alias = bytes(row.Alias)[:end * 2].decode('utf-16-le')
    except UnicodeError:
        raise OSError('Windows 网卡名称编码无效。') from None
    if not alias:
        raise OSError('Windows 网卡名称无效。')
    return alias


def _interfaces(rows):
    result = {}
    indices = set()
    for row in rows:
        if not row.InterfaceLuid or not row.InterfaceIndex or row.InterfaceLuid in result or row.InterfaceIndex in indices:
            raise OSError('Windows 网卡标识不完整或发生变化，请重试。')
        alias = _alias_text(row)
        # A reboot can leave this inactive sing-tun row in IP Helper even when
        # Get-NetAdapter no longer lists it. Do not treat every non-up state as
        # reusable: unknown, testing and dormant states are not proven idle.
        reusable = (alias.casefold() == INTERFACE_NAME and row.OperStatus == 2
                    and row.Type == 53 and bytes(row.InterfaceGuid) == _TUN_GUID_BYTES
                    and tuple(row.Description[:len(_TUN_DESCRIPTION)]) == _TUN_DESCRIPTION)
        result[row.InterfaceLuid] = (row.InterfaceIndex, alias, row.OperStatus == 1, reusable)
        indices.add(row.InterfaceIndex)
    return result


def _row_alias(row, interfaces):
    entry = interfaces.get(row.InterfaceLuid)
    if entry is None or entry[0] != row.InterfaceIndex:
        # The tables are not atomic. An unknown/changed identity must never be
        # dropped: it might own a route or WeakHostSend recovery obligation.
        raise OSError('Windows 网卡状态在读取期间发生变化，请重试。')
    return entry[1]


def _address(sockaddr):
    if sockaddr.Family == AF_INET:
        packed = bytes(sockaddr.Ipv4.Address.Bytes)
    elif sockaddr.Family == AF_INET6:
        packed = bytes(sockaddr.Ipv6.Address)
    else:
        raise OSError('Windows 网络状态包含未知地址类型。')
    return ipaddress.ip_address(packed)


def _unicast_address(row):
    value = str(_address(row.Address))
    # Get-NetIPAddress preserves the IPv6 zone, including link-local %index.
    if row.Address.Family == AF_INET6 and row.Address.Ipv6.ScopeId:
        value += f'%{row.Address.Ipv6.ScopeId}'
    return value


def _base_state(interfaces, routes):
    matches = [entry for entry in interfaces.values() if entry[1].casefold() == INTERFACE_NAME]
    state = {'exists': bool(matches), 'up': any(entry[2] for entry in matches), 'routes': 0}
    default_indices = set()
    for row in routes:
        alias = _row_alias(row, interfaces)
        address = _address(row.DestinationPrefix.Prefix)
        prefix = row.DestinationPrefix.PrefixLength
        if prefix > address.max_prefixlen:
            raise OSError('Windows 路由前缀长度无效。')
        if alias.casefold() == INTERFACE_NAME:
            state['routes'] += 1
        if prefix == 0 and address.is_unspecified:
            default_indices.add(row.InterfaceIndex)
    return state, default_indices


def _validate_interface(interface):
    if interface != INTERFACE_NAME:
        raise ValueError('invalid interface')


def tun_state(interface=INTERFACE_NAME, timeout=20):
    """Read adapter presence/state and all IPv4/IPv6 routes for our alias."""
    _validate_interface(interface)
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or timeout <= 0:
        raise ValueError('网络状态读取超时必须为正数。')
    deadline = time.monotonic() + timeout
    api = _api()
    interfaces = _interfaces(_read_table(api, 'GetIfTable2', deadline))
    state, _ = _base_state(interfaces, _read_table(api, 'GetIpForwardTable2', deadline))
    _check_deadline(deadline)
    return state


def network_state(interface=INTERFACE_NAME):
    """Full startup guard, including forwarding and every local unicast IP."""
    _validate_interface(interface)
    api = _api()
    interfaces = _interfaces(_read_table(api, 'GetIfTable2'))
    state, default_indices = _base_state(interfaces, _read_table(api, 'GetIpForwardTable2'))
    matches = [entry for entry in interfaces.values() if entry[1].casefold() == INTERFACE_NAME]
    state['reusable_inactive'] = len(matches) == 1 and matches[0][3] and state['routes'] == 0
    ip_rows = _read_table(api, 'GetIpInterfaceTable')
    for row in ip_rows:
        if row.Family not in (AF_INET, AF_INET6):
            raise OSError('Windows IP 网卡包含未知地址类型。')
        _row_alias(row, interfaces)
    if not default_indices.issubset({row.InterfaceIndex for row in ip_rows}):
        raise OSError('Windows 默认路由网卡状态不完整，请重试。')
    # Keep the original conservative cross-family check by interface index.
    state['forwarding'] = any(row.InterfaceIndex in default_indices and row.ForwardingEnabled for row in ip_rows)
    state['local_addresses'] = [_unicast_address(row) for row in _read_table(api, 'GetUnicastIpAddressTable')]
    return state


def capture_weak_host():
    """Capture both families, including down/hidden interfaces, for recovery."""
    api = _api()
    interfaces = _interfaces(_read_table(api, 'GetIfTable2'))
    result = []
    for row in _read_table(api, 'GetIpInterfaceTable'):
        if row.Family not in (AF_INET, AF_INET6):
            raise OSError('Windows IP 网卡包含未知地址类型。')
        if row.WeakHostSend:
            result.append({'InterfaceIndex': row.InterfaceIndex, 'InterfaceAlias': _row_alias(row, interfaces),
                           'AddressFamily': 'IPv4' if row.Family == AF_INET else 'IPv6'})
    return result
