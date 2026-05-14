import axios from 'axios';
import * as ImageManipulator from 'expo-image-manipulator';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { Camera, type CameraRef, useCameraPermission, usePhotoOutput } from 'react-native-vision-camera';

import { uploadBackLabelBurst } from '../api/scanClient';
import { API_BASE } from '../config/api';
import { mergeOcrFrames } from '../lib/ocrTextMerge';
import { defaultIngredientGuideRect, viewRectToImageCrop, type Rect } from '../lib/roiCrop';

function toFileUri(path: string): string {
  if (path.startsWith('file://')) return path;
  return Platform.OS === 'android' ? `file://${path}` : path;
}

export default function BackLabelRoiCaptureScreen() {
  const cameraRef = useRef<CameraRef>(null);
  const { hasPermission, requestPermission } = useCameraPermission();
  const photoOutput = usePhotoOutput({
    qualityPrioritization: 'quality',
  });

  const [container, setContainer] = useState({ width: 0, height: 0 });
  const guide = useMemo(
    () =>
      container.width > 0 && container.height > 0
        ? defaultIngredientGuideRect(container)
        : null,
    [container.width, container.height],
  );

  const [croppedUris, setCroppedUris] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [apiBase, setApiBase] = useState(API_BASE);
  const [pendingScanId, setPendingScanId] = useState('');
  const [uploadResult, setUploadResult] = useState<string | null>(null);

  const [demoA, setDemoA] = useState('정제수, 백설탕, 마토');
  const [demoB, setDemoB] = useState('백설탕, 토마토페이스트, 소금');
  const [demoMerged, setDemoMerged] = useState('');

  useEffect(() => {
    if (!hasPermission) requestPermission();
  }, [hasPermission, requestPermission]);

  const onCameraLayout = useCallback((e: { nativeEvent: { layout: { width: number; height: number } } }) => {
    const { width, height } = e.nativeEvent.layout;
    if (width > 0 && height > 0) setContainer({ width, height });
  }, []);

  useEffect(() => {
    if (!container.width || !cameraRef.current) return;
    const t = setTimeout(() => {
      cameraRef.current
        ?.focusTo({ x: container.width / 2, y: container.height / 2 })
        .catch(() => undefined);
    }, 400);
    return () => clearTimeout(t);
  }, [container.width, container.height]);

  const captureRoi = useCallback(async () => {
    if (!guide || !container.width) {
      setError('카메라 레이아웃이 아직 준비되지 않았습니다.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const photo = await photoOutput.capturePhoto({ flashMode: 'off' }, {});
      const pw = photo.width;
      const ph = photo.height;
      const saved = await photo.saveToTemporaryFileAsync();
      photo.dispose();

      const fullUri = toFileUri(saved);
      const crop = viewRectToImageCrop(guide, container, pw, ph, 'cover');
      const out = await ImageManipulator.manipulateAsync(
        fullUri,
        [{ crop: crop }],
        { compress: 0.9, format: ImageManipulator.SaveFormat.JPEG },
      );
      setCroppedUris((prev) => [...prev, out.uri]);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setBusy(false);
    }
  }, [photoOutput, guide, container]);

  const clearBurst = useCallback(() => {
    setCroppedUris([]);
    setUploadResult(null);
    setError(null);
  }, []);

  const runDemoMerge = useCallback(() => {
    setDemoMerged(mergeOcrFrames([demoA, demoB]));
  }, [demoA, demoB]);

  const uploadBurst = useCallback(async () => {
    const id = pendingScanId.trim();
    if (!id) {
      setError('pendingScanId를 입력하세요 (앞면 스캔 후 서버가 준 값).');
      return;
    }
    if (croppedUris.length === 0) {
      setError('업로드할 ROI 이미지가 없습니다. 캡처를 먼저 하세요.');
      return;
    }
    setBusy(true);
    setError(null);
    setUploadResult(null);
    try {
      const base = (apiBase || API_BASE).trim().replace(/\/$/, '') || API_BASE;
      const res = await uploadBackLabelBurst(id, croppedUris, { apiBase: base });
      setUploadResult(
        `ingredients: ${res.ingredients?.length ?? 0} · confidence: ${Number(res.confidence).toFixed(2)}\n` +
          `suggested: ${res.suggestedAction ?? '—'}\n` +
          (res.rawIngredientsText ? `\nraw: ${res.rawIngredientsText.slice(0, 400)}` : ''),
      );
    } catch (e: unknown) {
      if (axios.isAxiosError(e)) {
        const data = e.response?.data as { message?: string } | undefined;
        setError(data?.message ?? e.message);
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  }, [pendingScanId, croppedUris, apiBase]);

  if (!hasPermission) {
    return (
      <SafeAreaProvider>
        <SafeAreaView style={styles.center}>
          <Text style={styles.title}>카메라 권한이 필요합니다</Text>
          <Pressable style={styles.btn} onPress={requestPermission}>
            <Text style={styles.btnText}>권한 요청</Text>
          </Pressable>
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <Text style={styles.title}>뒷면 성분 ROI 촬영</Text>
          <Text style={styles.hint}>
            가이드 안에 성분 줄을 맞추고 여러 장 촬영한 뒤, 같은 pendingScanId로 업로드합니다. Vision 호출은 서버에서
            DOCUMENT_TEXT_DETECTION으로 처리됩니다.
          </Text>

          <Text style={styles.label}>API base</Text>
          <TextInput
            style={styles.input}
            value={apiBase}
            onChangeText={setApiBase}
            autoCapitalize="none"
            autoCorrect={false}
          />

          <Text style={styles.label}>pendingScanId (앞면 스캔 응답)</Text>
          <TextInput
            style={styles.input}
            value={pendingScanId}
            onChangeText={setPendingScanId}
            placeholder="예: abc-123-..."
            autoCapitalize="none"
          />

          <View style={styles.cameraWrap} onLayout={onCameraLayout}>
            <Camera
              ref={cameraRef}
              style={StyleSheet.absoluteFill}
              device="back"
              isActive
              outputs={[photoOutput]}
              resizeMode="cover"
              enableNativeTapToFocusGesture
            />
            {guide && container.height > 0 ? <RoiDimOverlay guide={guide} container={container} /> : null}
          </View>

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <View style={styles.row}>
            <Pressable style={[styles.btn, busy && styles.btnDisabled]} onPress={captureRoi} disabled={busy}>
              {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>ROI 캡처 추가</Text>}
            </Pressable>
            <Pressable style={[styles.btnSecondary]} onPress={clearBurst} disabled={busy}>
              <Text style={styles.btnSecondaryText}>비우기</Text>
            </Pressable>
          </View>

          <Text style={styles.meta}>캡처된 ROI: {croppedUris.length}장</Text>
          <ScrollView horizontal style={styles.thumbRow}>
            {croppedUris.map((uri, i) => (
              <Image key={`${uri}-${i}`} source={{ uri }} style={styles.thumb} />
            ))}
          </ScrollView>

          <Pressable
            style={[styles.btn, (croppedUris.length === 0 || busy) && styles.btnDisabled]}
            onPress={uploadBurst}
            disabled={busy || croppedUris.length === 0}
          >
            <Text style={styles.btnText}>서버로 버스트 업로드</Text>
          </Pressable>

          {uploadResult ? <Text style={styles.result}>{uploadResult}</Text> : null}

          <Text style={styles.section}>로컬 OCR 텍스트 병합 데모 (순서 보존 overlap)</Text>
          <TextInput style={styles.input} value={demoA} onChangeText={setDemoA} />
          <TextInput style={styles.input} value={demoB} onChangeText={setDemoB} />
          <Pressable style={styles.btnSecondary} onPress={runDemoMerge}>
            <Text style={styles.btnSecondaryText}>병합 실행</Text>
          </Pressable>
          {demoMerged ? <Text style={styles.result}>{demoMerged}</Text> : null}
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function RoiDimOverlay({ guide, container }: { guide: Rect; container: { width: number; height: number } }) {
  const { left, top, width, height } = guide;
  const w = container.width;
  const h = container.height;
  const dim = 'rgba(0,0,0,0.52)';
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <View style={[styles.dimBand, { top: 0, height: top, width: w, backgroundColor: dim }]} />
      <View style={[styles.dimBand, { top: top + height, height: h - top - height, width: w, backgroundColor: dim }]} />
      <View style={[styles.dimBand, { top, left: 0, width: left, height, backgroundColor: dim }]} />
      <View
        style={[
          styles.dimBand,
          { top, left: left + width, width: w - left - width, height, backgroundColor: dim },
        ]}
      />
      <View style={[styles.guideBorder, { left, top, width, height }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#FDFBF7' },
  scroll: { padding: 16, paddingBottom: 32 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, backgroundColor: '#FDFBF7' },
  title: { fontSize: 20, fontWeight: '700', color: '#1B4332', marginBottom: 8 },
  hint: { fontSize: 14, color: '#52796F', marginBottom: 16, lineHeight: 20 },
  label: { fontSize: 13, fontWeight: '600', color: '#2D6A4F', marginBottom: 4 },
  input: {
    borderWidth: 1,
    borderColor: '#D8E2DC',
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
    backgroundColor: '#fff',
    fontSize: 15,
  },
  cameraWrap: {
    width: '100%',
    aspectRatio: 3 / 4,
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: '#000',
    marginBottom: 12,
  },
  dimBand: { position: 'absolute', left: 0 },
  guideBorder: {
    position: 'absolute',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.95)',
    borderRadius: 10,
  },
  row: { flexDirection: 'row', gap: 10, marginBottom: 8 },
  btn: {
    flex: 1,
    backgroundColor: '#2D6A4F',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnDisabled: { opacity: 0.45 },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  btnSecondary: {
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2D6A4F',
    justifyContent: 'center',
  },
  btnSecondaryText: { color: '#2D6A4F', fontWeight: '600' },
  meta: { fontSize: 13, color: '#52796F', marginBottom: 8 },
  thumbRow: { marginBottom: 12 },
  thumb: { width: 72, height: 72, borderRadius: 8, marginRight: 8, backgroundColor: '#eee' },
  error: { color: '#E76F51', marginBottom: 8, fontSize: 14 },
  result: {
    marginTop: 8,
    padding: 12,
    backgroundColor: '#fff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#D8E2DC',
    fontSize: 13,
    color: '#264653',
  },
  section: { marginTop: 20, fontSize: 16, fontWeight: '700', color: '#1B4332', marginBottom: 8 },
});
