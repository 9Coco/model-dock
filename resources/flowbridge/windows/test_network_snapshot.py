"""Windows IP Helper decoder/ownership tests; never create a TUN or set state."""

import ctypes as c
import ipaddress
import os
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from windows import network_snapshot as n


def interface(index, alias, *, up=True, luid=None, tun_identity=False):
    row = n.MIB_IF_ROW2()
    row.InterfaceIndex = index
    row.InterfaceLuid = luid if luid is not None else index * 100
    row.OperStatus = 1 if up else 2
    value = alias.encode('utf-16-le')
    c.memmove(c.addressof(row) + n.MIB_IF_ROW2.Alias.offset, value, len(value))
    if tun_identity:
        row.Type = 53
        # Frozen fixture from the bundled sing-tun name-to-GUID algorithm.
        identity = bytes.fromhex('a06b37bf2b0eaf495c0c5c1e40009762')
        c.memmove(c.byref(row.InterfaceGuid), identity, len(identity))
        description = 'sing-tun Tunnel'.encode('utf-16-le')
        c.memmove(c.addressof(row) + n.MIB_IF_ROW2.Description.offset, description, len(description))
    return row


def address(value, scope=0):
    value = ipaddress.ip_address(value)
    result = n.SOCKADDR_INET()
    if value.version == 4:
        result.Ipv4.Family = n.AF_INET
        result.Ipv4.Address.Bytes[:] = value.packed
    else:
        result.Ipv6.Family = n.AF_INET6
        result.Ipv6.Address[:] = value.packed
        result.Ipv6.ScopeId = scope
    return result


def route(index, prefix, *, luid=None):
    row = n.MIB_IPFORWARD_ROW2()
    row.InterfaceIndex = index
    row.InterfaceLuid = luid if luid is not None else index * 100
    network = ipaddress.ip_network(prefix)
    row.DestinationPrefix.Prefix = address(network.network_address)
    row.DestinationPrefix.PrefixLength = network.prefixlen
    return row


def ip_interface(index, family=n.AF_INET, *, weak=False, forwarding=False, luid=None):
    row = n.MIB_IPINTERFACE_ROW()
    row.Family, row.InterfaceIndex = family, index
    row.InterfaceLuid = luid if luid is not None else index * 100
    row.WeakHostSend, row.ForwardingEnabled = weak, forwarding
    return row


def unicast(value, *, scope=0):
    row = n.MIB_UNICASTIPADDRESS_ROW()
    row.Address = address(value, scope)
    row.ScopeId = scope
    return row


class Tables:
    """Allocate real ctypes table memory and poison it when FreeMibTable runs."""
    def __init__(self, interfaces=(), routes=(), ip_interfaces=(), addresses=(), *, errors=None, null=(), counts=None):
        self.rows = dict(zip(n._TABLES, (interfaces, ip_interfaces, routes, addresses)))
        self.errors, self.null, self.counts = errors or {}, set(null), counts or {}
        self.buffers, self.calls, self.freed = {}, [], []
        for name in n._TABLES:
            setattr(self, name, Mock(side_effect=lambda *args, name=name: self.read(name, args)))
        self.FreeMibTable = Mock(side_effect=self.free)

    def read(self, name, args):
        self.calls.append(name)
        if name != 'GetIfTable2':
            assert args[0] == n.AF_UNSPEC
        if name not in self.null:
            table_type, row_type = n._TABLES[name]
            rows = self.rows[name]
            allocated = c.create_string_buffer(table_type.Table.offset + max(1, len(rows)) * c.sizeof(row_type))
            c.cast(allocated, c.POINTER(n.U32))[0] = self.counts.get(name, len(rows))
            for index, row in enumerate(rows):
                c.memmove(c.addressof(allocated) + table_type.Table.offset + index * c.sizeof(row_type), c.byref(row), c.sizeof(row_type))
            self.buffers[c.addressof(allocated)] = allocated
            c.cast(args[-1], c.POINTER(c.POINTER(table_type)))[0] = c.cast(allocated, c.POINTER(table_type))
        return self.errors.get(name, 0)

    def free(self, pointer):
        location = c.cast(pointer, c.c_void_p).value
        assert location not in self.freed, 'double free'
        self.freed.append(location)
        allocated = self.buffers[location]
        c.memset(location, 0xdd, c.sizeof(allocated))


class NetworkSnapshotTests(unittest.TestCase):
    def test_layout_matches_microsoft_sdk_64_bit_offsets(self):
        for name, (size, offsets) in {
            'MIB_IF_ROW2': (1352, {'InterfaceLuid': 0, 'InterfaceIndex': 8, 'Alias': 28,
                'Description': 542, 'PhysicalAddressLength': 1056, 'InterfaceAndOperStatusFlags': 1152,
                'OperStatus': 1156, 'NetworkGuid': 1168, 'TransmitLinkSpeed': 1192}),
            'MIB_IPINTERFACE_ROW': (168, {'Family': 0, 'InterfaceLuid': 8, 'InterfaceIndex': 16,
                'ForwardingEnabled': 41, 'WeakHostSend': 42, 'ZoneIndices': 80, 'Metric': 148,
                'Connected': 156, 'ReachableTime': 160, 'TransmitOffload': 164, 'ReceiveOffload': 165, 'DisableDefaultRoutes': 166}),
            'MIB_IPFORWARD_ROW2': (104, {'InterfaceLuid': 0, 'InterfaceIndex': 8, 'DestinationPrefix': 12,
                'NextHop': 44, 'ValidLifetime': 76, 'Metric': 84, 'Loopback': 92, 'Age': 96}),
            'MIB_UNICASTIPADDRESS_ROW': (80, {'Address': 0, 'InterfaceLuid': 32, 'InterfaceIndex': 40,
                'OnLinkPrefixLength': 60, 'SkipAsSource': 61, 'DadState': 64, 'ScopeId': 68, 'CreationTimeStamp': 72}),
        }.items():
            structure = getattr(n, name)
            self.assertEqual(c.sizeof(structure), size, name)
            for field, offset in offsets.items():
                self.assertEqual(getattr(structure, field).offset, offset, f'{name}.{field}')
        self.assertEqual(c.sizeof(n.SOCKADDR_INET), 28)
        self.assertEqual(c.alignment(n.SOCKADDR_INET), 4)
        self.assertEqual(c.sizeof(n.IP_ADDRESS_PREFIX), 32)
        self.assertEqual(n.IP_ADDRESS_PREFIX.PrefixLength.offset, 28)
        for table, _ in n._TABLES.values():
            self.assertEqual(table.Table.offset, 8)

    def test_dual_stack_state_uses_exact_alias_and_counts_every_matching_route(self):
        api = Tables(interfaces=[interface(1, 'Loopback'), interface(2, 'MODELDOCK-NET'), interface(3, 'modeldock-net-copy')],
                     routes=[route(1, '127.0.0.0/8'), route(2, '0.0.0.0/1'), route(2, '128.0.0.0/1'),
                             route(2, '::/1'), route(2, '8000::/1'), route(3, '::/0')])
        with patch.object(n, '_api', return_value=api):
            self.assertEqual(n.tun_state(), {'exists': True, 'up': True, 'routes': 4})
        self.assertEqual(api.calls, ['GetIfTable2', 'GetIpForwardTable2'])
        self.assertEqual(len(api.freed), 2)

    def test_missing_interface_and_present_down_interface_are_distinct(self):
        for rows, expected in (([], {'exists': False, 'up': False, 'routes': 0}),
                               ([interface(2, 'modeldock-net', up=False)], {'exists': True, 'up': False, 'routes': 0})):
            api = Tables(interfaces=rows)
            with self.subTest(expected=expected), patch.object(n, '_api', return_value=api):
                self.assertEqual(n.tun_state(), expected)
            self.assertEqual(len(api.freed), 2)

    def test_full_guard_detects_default_interface_forwarding_across_families(self):
        for family, prefix in ((n.AF_INET, '0.0.0.0/0'), (n.AF_INET6, '::/0')):
            api = Tables(interfaces=[interface(2, 'Ethernet'), interface(3, 'Other')],
                         routes=[route(2, prefix)], ip_interfaces=[ip_interface(2, family),
                         ip_interface(2, n.AF_INET6 if family == n.AF_INET else n.AF_INET, forwarding=True),
                         ip_interface(3, forwarding=True)],
                         addresses=[unicast('192.0.2.10'), unicast('::1'), unicast('fe80::1234', scope=12)])
            with self.subTest(family=family), patch.object(n, '_api', return_value=api):
                state = n.network_state()
            self.assertTrue(state['forwarding'])
            self.assertEqual(state['local_addresses'], ['192.0.2.10', '::1', 'fe80::1234%12'])
            self.assertEqual(len(api.freed), 4)

    def test_known_down_route_free_adapter_can_be_reused_after_reboot(self):
        api = Tables(interfaces=[interface(50, 'modeldock-net', up=False, tun_identity=True)])
        with patch.object(n, '_api', return_value=api):
            state = n.network_state()
        self.assertTrue(state['exists'])
        self.assertFalse(state['up'])
        self.assertEqual(state['routes'], 0)
        self.assertTrue(state['reusable_inactive'])
        self.assertEqual(len(api.freed), 4)

    def test_reuse_requires_exact_known_identity_and_explicit_down_status(self):
        for changed in ('guid', 'description', 'type', 'name', 'missing', 'multiple',
                        'status0', 'status1', 'status3', 'status4', 'status5', 'status6', 'status7'):
            row = interface(50, 'modeldock-net', up=False, tun_identity=True)
            rows = [row]
            if changed == 'guid': row.InterfaceGuid.Data1 ^= 1
            elif changed == 'description': row.Description[0] = ord('X')
            elif changed == 'type': row.Type = 6
            elif changed == 'name': row.Alias[0] = ord('X')
            elif changed == 'missing': rows = []
            elif changed == 'multiple': rows.append(interface(51, 'modeldock-net', up=False, tun_identity=True))
            else: row.OperStatus = int(changed[6:])
            with self.subTest(changed=changed), patch.object(n, '_api', return_value=Tables(interfaces=rows)):
                self.assertFalse(n.network_state()['reusable_inactive'])

    def test_any_remaining_route_prevents_reuse_of_known_down_adapter(self):
        for prefix in ('0.0.0.0/1', '::/1', '172.31.255.0/30', 'fd42:73fb:4827::/126'):
            api = Tables(interfaces=[interface(50, 'modeldock-net', up=False, tun_identity=True)],
                         routes=[route(50, prefix)])
            with self.subTest(prefix=prefix), patch.object(n, '_api', return_value=api):
                state = n.network_state()
            self.assertEqual(state['routes'], 1)
            self.assertFalse(state['reusable_inactive'])

    def test_nondefault_forwarding_and_split_routes_do_not_count_as_default(self):
        api = Tables(interfaces=[interface(2, 'Ethernet'), interface(3, 'modeldock-net')],
                     routes=[route(2, '0.0.0.0/0'), route(3, '0.0.0.0/1'), route(3, '::/1')],
                     ip_interfaces=[ip_interface(2), ip_interface(3, forwarding=True)])
        with patch.object(n, '_api', return_value=api):
            self.assertFalse(n.network_state()['forwarding'])

    def test_weak_host_includes_down_logical_interfaces_and_both_families(self):
        api = Tables(interfaces=[interface(5, '隧道接口', up=False), interface(2, 'Ethernet')],
                     ip_interfaces=[ip_interface(5, weak=True), ip_interface(5, n.AF_INET6, weak=True), ip_interface(2)])
        with patch.object(n, '_api', return_value=api):
            self.assertEqual(n.capture_weak_host(), [
                {'InterfaceIndex': 5, 'InterfaceAlias': '隧道接口', 'AddressFamily': 'IPv4'},
                {'InterfaceIndex': 5, 'InterfaceAlias': '隧道接口', 'AddressFamily': 'IPv6'}])
        self.assertEqual(api.calls, ['GetIfTable2', 'GetIpInterfaceTable'])
        self.assertEqual(len(api.freed), 2)

    def test_missing_or_reused_interface_identity_never_drops_routes_or_recovery(self):
        for luid in (999, 200):
            api = Tables(interfaces=[interface(2, 'Ethernet')], routes=[route(3, '::/0', luid=luid)])
            with self.subTest(luid=luid), patch.object(n, '_api', return_value=api):
                with self.assertRaises(OSError): n.tun_state()
            self.assertEqual(len(api.freed), 2)
        api = Tables(interfaces=[], ip_interfaces=[ip_interface(3, weak=True)])
        with patch.object(n, '_api', return_value=api):
            with self.assertRaises(OSError): n.capture_weak_host()
        self.assertEqual(len(api.freed), 2)

    def test_default_route_without_ip_interface_information_rejects(self):
        api = Tables(interfaces=[interface(2, 'Ethernet')], routes=[route(2, '::/0')])
        with patch.object(n, '_api', return_value=api):
            with self.assertRaises(OSError): n.network_state()
        self.assertEqual(len(api.freed), 3)

    def test_alias_decoding_stops_at_nul_and_ignores_unused_surrogate_tail(self):
        row = interface(2, '隧道😀')
        end = list(row.Alias).index(0)
        row.Alias[end + 1] = 0xd800
        self.assertEqual(n._alias_text(row), '隧道😀')
        row.Alias[:] = [1] * 257
        with self.assertRaises(OSError): n._alias_text(row)
        row.Alias[0], row.Alias[1] = 0xd800, 0
        with self.assertRaises(OSError): n._alias_text(row)

    def test_each_api_error_is_failure_and_releases_any_returned_allocation(self):
        for name in n._TABLES:
            for null in ((), (name,)):
                api = Tables(errors={name: 5}, null=null)
                with self.subTest(name=name, null=bool(null)):
                    with self.assertRaisesRegex(OSError, name): n._read_table(api, name)
                self.assertEqual(len(api.freed), 0 if null else 1)

    def test_successful_null_pointer_and_invalid_row_count_reject_without_leaks(self):
        for name in n._TABLES:
            api = Tables(null=(name,))
            with self.subTest(name=name), self.assertRaises(OSError): n._read_table(api, name)
            self.assertEqual(len(api.freed), 0)
            api = Tables(counts={name: n._MAX_ROWS + 1})
            with self.subTest(name=name), self.assertRaises(OSError): n._read_table(api, name)
            self.assertEqual(len(api.freed), 1)

    def test_unknown_address_family_and_bad_prefix_fail_after_tables_are_freed(self):
        for invalid_family in (True, False):
            row = route(2, '0.0.0.0/0')
            if invalid_family: row.DestinationPrefix.Prefix.Family = 999
            else: row.DestinationPrefix.PrefixLength = 33
            api = Tables(interfaces=[interface(2, 'Ethernet')], routes=[row])
            with self.subTest(family=invalid_family), patch.object(n, '_api', return_value=api):
                with self.assertRaises(OSError): n.tun_state()
            self.assertEqual(len(api.freed), 2)

    def test_invalid_input_never_calls_windows(self):
        with patch.object(n, '_api') as api:
            for timeout in (0, -1, True, float('nan'), float('inf'), '20'):
                with self.subTest(timeout=timeout), self.assertRaises(ValueError): n.tun_state(timeout=timeout)
            with self.assertRaises(ValueError): n.tun_state('Wi-Fi')
            with self.assertRaises(ValueError): n.network_state('modeldock-net-copy')
            api.assert_not_called()

    def test_elapsed_api_deadline_fails_and_still_frees_memory(self):
        api = Tables()
        clock = SimpleNamespace(monotonic=Mock(side_effect=[0, 0, 2]))
        with patch.object(n, '_api', return_value=api), patch.object(n, 'time', clock):
            with self.assertRaises(TimeoutError): n.tun_state(timeout=1)
        self.assertEqual(api.calls, ['GetIfTable2'])
        self.assertEqual(len(api.freed), 1)

    @unittest.skipUnless(os.name == 'nt', 'Windows read-only IP Helper integration')
    def test_real_read_only_snapshots_have_valid_schemas(self):
        state = n.network_state()
        self.assertEqual(set(state), {'exists', 'up', 'routes', 'forwarding', 'local_addresses', 'reusable_inactive'})
        self.assertIsInstance(state['reusable_inactive'], bool)
        self.assertIsInstance(state['forwarding'], bool)
        for value in state['local_addresses']: ipaddress.ip_address(value)
        self.assertEqual(set(n.tun_state()), {'exists', 'up', 'routes'})
        for row in n.capture_weak_host():
            self.assertEqual(set(row), {'InterfaceIndex', 'InterfaceAlias', 'AddressFamily'})
            self.assertGreater(row['InterfaceIndex'], 0)
            self.assertIn(row['AddressFamily'], ('IPv4', 'IPv6'))
            self.assertTrue(row['InterfaceAlias'])


if __name__ == '__main__':
    unittest.main()
