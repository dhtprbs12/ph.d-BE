# PHD Mobile (Expo)

React Native (Expo SDK 54) 스캔 실험 앱: **Vision Camera + ROI 크롭 + 버스트 업로드** (`/api/scan/back-multi/:pendingScanId`). Cloud Vision은 **서버**에서 `DOCUMENT_TEXT_DETECTION`으로 실행됩니다.

## 요구 사항

- Node 20+
- iOS/Android 실기기 또는 시뮬레이터 — **카메라** 사용 (Expo Go는 Vision Camera 네이티브 모듈 제약이 있을 수 있어 `npx expo prebuild` 후 개발 빌드를 권장).

## 실행

```bash
cd mobile
npm install
npx expo start
```

API 주소는 기본값 `https://phd-be-production.up.railway.app/api` 이며, 화면에서 수정 가능합니다. `pendingScanId`는 앱의 앞면 스캔 응답에서 받은 값을 붙여 넣습니다.

## 구성

| 경로 | 설명 |
|------|------|
| `src/screens/BackLabelRoiCaptureScreen.tsx` | 가이드 ROI, 촬영, 썸네일, `/back-multi` 업로드 |
| `src/lib/roiCrop.ts` | 프리뷰 `cover` 기준 가이드 → 원본 픽셀 크롭 |
| `src/lib/ocrTextMerge.ts` | 로컬 데모용 overlap 병합 (자카드 집합 병합 아님) |
| `src/api/scanClient.ts` | multipart `images` 업로드 |

## 네이티브 빌드

Vision Camera v5는 Nitro 기반이라 **커스텀 개발 빌드**가 필요할 수 있습니다.

```bash
npx expo prebuild
npx expo run:ios   # 또는 run:android
```
