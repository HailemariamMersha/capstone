import React, { useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { Button, Text } from 'react-native-paper';
import { MaterialDesignIcons } from '@react-native-vector-icons/material-design-icons';
import { theme } from './theme';

const fullDetails =
  'SkyMeasure studies network connectivity using active ICMP, TCP, UDP, traceroute and small HTTP transfers. Start once per trip and stop whenever you wish. Tests use battery and data: this private pilot has no M-Lab byte cap or overall 300 MiB trip ceiling. Other application-accounted allocations remain 60 MiB controlled transfers, 20 MiB diagnostics/context and 20 MiB live uploads. Network overhead and post-trip uploads are additional. Records save locally, with brief upload attempts every 15 minutes over Wi-Fi by default. We store timing, failures, IP addresses, available Wi-Fi identifiers, battery, ASN-based detection decisions and required participant-reported flight details. Automatic trips do not collect GPS observations. We never save GPS coordinates or monitor other apps or browsing. Participation is pseudonymous, not unidentifiable: flight details, times and public IPs can identify a journey or person when combined with other information. Approved researchers can access these records. Starting a trip also authorizes one automatic M-Lab NDT7 download/upload speed test after suitable connectivity is detected. The pilot allows one normal-duration M-Lab pair per trip without a byte cutoff, subject to four attempts per 24 hours. Fast connections can consume gigabytes. Stop and watchdog time limits remain. Recorded client payload counters exclude transport overhead and are not exact carrier-billed traffic. M-Lab collects and publicly publishes your public IP address, test time and network performance data under its platform privacy policy (https://www.measurementlab.net/privacy/). This publication is separate from our private research database; deleting SkyMeasure data does not remove M-Lab publications. We do not send M-Lab your flight form or GPS observations. Stop trip cancels further testing, but cannot retract data already sent. You can request deletion; reinstalling or resetting the app may lose access to your anonymous identity. This is staging research information requiring study-team approval before recruitment.';
function Note({
  title,
  children,
  icon,
}: {
  title: string;
  children: React.ReactNode;
  icon: React.ComponentProps<typeof MaterialDesignIcons>['name'];
}) {
  return (
    <View style={styles.note}>
      <View style={styles.icon} accessible={false}>
        <MaterialDesignIcons
          name={icon}
          size={22}
          color={theme.colors.primary}
        />
      </View>
      <View style={styles.copy}>
        <Text variant="titleMedium" style={styles.title}>
          {title}
        </Text>
        <Text style={styles.description}>{children}</Text>
      </View>
    </View>
  );
}
export default function ParticipationInfo() {
  const [expanded, setExpanded] = useState(false);
  return (
    <View style={styles.content}>
      <Note title="Connection tests" icon="wifi">
        SkyMeasure runs connection and speed tests to help researchers
        understand in-flight Wi-Fi. Tests use data and battery; speed tests can
        use substantial data. The private pilot speed test has no byte cap and
        can use gigabytes. You can stop at any time.
      </Note>
      <Note title="Your privacy matters" icon="shield-check-outline">
        Researchers receive connection results, available Wi-Fi identifiers and
        flight details you add. These may identify a journey. Automatic trips do
        not collect GPS.
      </Note>
      <View style={styles.publication}>
        <Text variant="titleMedium" style={styles.title}>
          About the M-Lab speed test
        </Text>
        <Text style={styles.description}>
          M-Lab collects and publicly publishes your public IP address and test
          results. Deleting your SkyMeasure data does not remove M-Lab
          publications.
        </Text>
        <Button
          accessibilityLabel="Read M-Lab public data policy"
          onPress={() =>
            Linking.openURL('https://www.measurementlab.net/privacy/').catch(
              () => {},
            )
          }
          style={styles.policy}
        >
          M-Lab public data policy
        </Button>
      </View>
      <Button
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(value => !value)}
      >
        {expanded ? 'Hide study details' : 'Read full study details'}
      </Button>
      {expanded && <Text style={styles.description}>{fullDetails}</Text>}
    </View>
  );
}
const styles = StyleSheet.create({
  content: { gap: 20 },
  note: { flexDirection: 'row', gap: 14 },
  icon: {
    width: 42,
    height: 42,
    borderRadius: 14,
    backgroundColor: '#E8F5F1',
    alignItems: 'center',
    justifyContent: 'center',
  },
  copy: { flex: 1, gap: 6 },
  title: { fontWeight: '600' },
  description: { color: theme.colors.onSurfaceVariant, lineHeight: 23 },
  publication: {
    padding: 20,
    borderRadius: 22,
    backgroundColor: '#E8F5F1',
    gap: 10,
  },
  policy: { alignSelf: 'flex-start', marginLeft: -12 },
});
