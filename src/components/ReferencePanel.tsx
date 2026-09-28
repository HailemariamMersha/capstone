import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  Button,
  Linking,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { measurementStore } from '../storage/database';
import { referenceHtml } from '../reference/html';
import { parseReferenceMessage } from '../reference/protocol';
import type { ReferenceResult } from '../reference/protocol';
import { createReferenceSession } from '../reference/session';
import type { ReferenceSession } from '../reference/session';

export default function ReferencePanel({
  idle,
  onBusyChange,
  onSaved,
}: {
  idle: boolean;
  onBusyChange: (busy: boolean) => void;
  onSaved: () => void;
}) {
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState<{ html: string } | null>(null);
  const [message, setMessage] = useState(
    'Ready for a separate NDT7 reference test.',
  );
  const active = useRef<ReferenceSession | null>(null);
  const latest = useRef<ReferenceResult[]>([]);
  const working = useRef(false);
  const cancelling = useRef(false);
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const finish = useCallback(
    async (reason: string) => {
      cancelling.current = true;
      if (timer.current !== undefined) {
        clearTimeout(timer.current);
      }
      // Destroy the WebView immediately, before waiting for any SQLite write.
      if (mounted.current) {
        setSource(null);
      }
      const run = active.current;
      if (!run) {
        return;
      }
      active.current = null;
      try {
        await run.finish(latest.current, reason);
        if (mounted.current) {
          setMessage(
            `Reference test ended: ${reason}. Results and partial samples are in Saved sessions.`,
          );
          onSaved();
        }
      } catch (error) {
        if (mounted.current) {
          setMessage(`Could not save all reference results: ${String(error)}`);
        }
      } finally {
        working.current = false;
        onBusyChange(false);
        if (mounted.current) {
          setBusy(false);
        }
      }
    },
    [onBusyChange, onSaved],
  );
  const finishRef = useRef(finish);
  finishRef.current = finish;
  useEffect(() => {
    mounted.current = true;
    const listener = AppState.addEventListener('change', state => {
      if (state !== 'active' && working.current) {
        finishRef.current('cancelled');
      }
    });
    return () => {
      mounted.current = false;
      listener.remove();
      finishRef.current('cancelled');
    };
  }, []);
  async function start() {
    if (
      !idle ||
      !accepted ||
      working.current ||
      AppState.currentState !== 'active'
    ) {
      return;
    }
    working.current = true;
    cancelling.current = false;
    latest.current = [];
    setBusy(true);
    onBusyChange(true);
    setMessage('Preparing reference test…');
    try {
      const run = await createReferenceSession(measurementStore, accepted);
      active.current = run;
      if (mounted.current) {
        setAccepted(false);
      }
      if (
        cancelling.current ||
        !mounted.current ||
        AppState.currentState !== 'active'
      ) {
        await finish('cancelled');
        return;
      }
      setSource({ html: referenceHtml(run.id) });
      timer.current = setTimeout(() => finishRef.current('timeout'), 50000);
    } catch (error) {
      working.current = false;
      onBusyChange(false);
      if (mounted.current) {
        setBusy(false);
        setMessage(String(error));
      }
    }
  }
  return (
    <View style={styles.panel}>
      <Text style={styles.title}>M-Lab NDT7 reference test</Text>
      <Text>
        Runs a download and upload to M-Lab, separately from scheduled
        collection. M-Lab collects your public IP address and publishes
        measurement results. This is optional.
      </Text>
      <Button
        title="Read M-Lab data policy"
        onPress={() =>
          Linking.openURL('https://www.measurementlab.net/privacy/').catch(
            error => setMessage(String(error)),
          )
        }
      />
      <Text>
        Each direction normally runs for about 10 seconds. We stop at a reported
        50 MiB per direction, but buffered traffic can exceed that threshold.
        This is not a hard data cap. Keep the app open; leaving it cancels the
        test.
      </Text>
      <Text>I accept M-Lab data publication and this test’s data usage.</Text>
      <Switch
        accessibilityLabel="Accept M-Lab reference test"
        value={accepted}
        disabled={busy}
        onValueChange={setAccepted}
      />
      <Button
        title="Start NDT7 reference test"
        disabled={!idle || !accepted || busy}
        onPress={start}
      />
      <Button
        title="Cancel reference test"
        disabled={!busy}
        onPress={() => finish('cancelled')}
      />
      <Text accessibilityLiveRegion="polite">{message}</Text>
      {source && (
        <WebView
          testID="ndt7-webview"
          source={source}
          // Route every navigation through our blocker. A narrower whitelist
          // would make WebView open rejected origins in an external browser.
          originWhitelist={['*']}
          onShouldStartLoadWithRequest={request =>
            request.url === 'about:blank'
          }
          javaScriptEnabled
          domStorageEnabled={false}
          allowFileAccess={false}
          allowFileAccessFromFileURLs={false}
          allowUniversalAccessFromFileURLs={false}
          mixedContentMode="never"
          javaScriptCanOpenWindowsAutomatically={false}
          setSupportMultipleWindows
          onOpenWindow={() => finish('invalid_response')}
          onError={() => finish('network')}
          onRenderProcessGone={() => finish('interrupted')}
          onContentProcessDidTerminate={() => finish('interrupted')}
          onMessage={event => {
            const run = active.current;
            if (!run) {
              return;
            }
            try {
              const next = parseReferenceMessage(
                event.nativeEvent.data,
                run.id,
              );
              latest.current = next.results;
              setMessage(
                next.results
                  .map(
                    result =>
                      `${result.direction}: ${result.reason} · ${(
                        (result.clientBytes ?? 0) / 1048576
                      ).toFixed(2)} MiB reported`,
                  )
                  .join('\n') || 'Discovering M-Lab server…',
              );
              if (next.type === 'finished') {
                finish(next.reason!);
              }
            } catch {
              finish('invalid_response');
            }
          }}
          style={styles.webview}
        />
      )}
    </View>
  );
}
const styles = StyleSheet.create({
  panel: { padding: 16, gap: 12, backgroundColor: '#fff', borderRadius: 12 },
  title: { fontSize: 22, fontWeight: '700', color: '#112d42' },
  webview: { height: 90, flex: 0 },
});
