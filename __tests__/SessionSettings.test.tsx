import React from 'react';
import { Button, TextInput } from 'react-native';
import { act, create } from 'react-test-renderer';
import type { ReactTestRenderer } from 'react-test-renderer';
import SessionSettings from '../src/components/SessionSettings';

test('custom sizes are saved as bytes and invalid edits cannot start a session', async () => {
  const start = jest.fn().mockResolvedValue(undefined);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<SessionSettings disabled={false} onStart={start} />);
  });
  await act(async () => {
    renderer.root
      .findAllByType(Button)
      .find(n => n.props.title === 'HTTP measurements: off')!
      .props.onPress();
  });
  const input = (label: string) =>
    renderer.root
      .findAllByType(TextInput)
      .find(n => n.props.accessibilityLabel === label)!;
  const button = () =>
    renderer.root
      .findAllByType(Button)
      .find(n => n.props.title === 'Start session')!;
  try {
    await act(async () => {
      input('Download size (MiB)').props.onChangeText('2.5');
      input('Upload size (MiB)').props.onChangeText('2');
    });
    await act(async () => {
      await button().props.onPress();
    });
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ downloadBytes: 2621440, uploadBytes: 2097152 }),
    );
    start.mockClear();
    await act(async () => {
      input('Upload size (MiB)').props.onChangeText('');
    });
    await act(async () => {
      await button().props.onPress();
    });
    expect(start).not.toHaveBeenCalled();
    await act(async () => {
      renderer.update(<SessionSettings disabled={true} onStart={start} />);
    });
    expect(input('Download size (MiB)').props.editable).toBe(false);
  } finally {
    await act(async () => renderer.unmount());
  }
});
