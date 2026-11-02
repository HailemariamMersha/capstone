import React, { useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { Button, Text } from 'react-native-paper';
import { WebView } from 'react-native-webview';
import configuration from '../config/public.json';
import { configured } from '../auth/client';
export default function Enrollment({
  onEnroll,
  busy,
}: {
  onEnroll(token?: string): Promise<void>;
  busy: boolean;
}) {
  const [challenge, setChallenge] = useState(false);
  const url = (configuration as { enrollmentUrl?: string }).enrollmentUrl;
  return (
    <View>
      <Button
        mode="contained"
        style={styles.button}
        contentStyle={styles.buttonContent}
        labelStyle={styles.buttonLabel}
        disabled={busy || !configured}
        loading={busy}
        onPress={() => (url ? setChallenge(true) : onEnroll())}
      >
        Get started
      </Button>
      {challenge && url && (
        <>
          <Text>
            Complete the enrollment check. No email or password is needed.
          </Text>
          <WebView
            style={styles.challenge}
            source={{ uri: url }}
            originWhitelist={[new URL(url).origin]}
            onShouldStartLoadWithRequest={request =>
              request.url === 'about:blank' ||
              new URL(request.url).origin === new URL(url).origin
            }
            onMessage={event => {
              if (new URL(event.nativeEvent.url).origin !== new URL(url).origin)
                return;
              try {
                const data = JSON.parse(event.nativeEvent.data);
                if (
                  typeof data.token === 'string' &&
                  data.token.length > 0 &&
                  data.token.length < 4096
                ) {
                  setChallenge(false);
                  onEnroll(data.token);
                }
              } catch {
                /* Only the enrollment page may submit a token. */
              }
            }}
          />
          <Button onPress={() => setChallenge(false)}>Cancel</Button>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  challenge: { height: 220 },
  button: { borderRadius: 18 },
  buttonContent: { minHeight: 58 },
  buttonLabel: { fontSize: 17, fontWeight: '600' },
});
