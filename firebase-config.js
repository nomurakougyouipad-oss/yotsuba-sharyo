// 社用車管理アプリ Firebase 設定（プロジェクト: yotsuba-sharyo）
// Firebase JS SDK v12.19.0（CDN / script type="module" で読み込む）
export const firebaseConfig = {
  apiKey: "AIzaSyBAojmnXm1dnvkbIKhZ3g1iijkpVu9OG4g",
  authDomain: "yotsuba-sharyo.firebaseapp.com",
  projectId: "yotsuba-sharyo",
  storageBucket: "yotsuba-sharyo.firebasestorage.app",
  messagingSenderId: "428021791978",
  appId: "1:428021791978:web:89f40a93a9f6e89fd06b93"
};
export const FIREBASE_SDK_VERSION = "12.19.0";
// プッシュ通知の公開鍵（Firebase コンソール → プロジェクトの設定 → Cloud Messaging → ウェブプッシュ証明書 の「鍵ペア」）
// 空のあいだは通知の機能を出さない
export const VAPID_KEY = "";
