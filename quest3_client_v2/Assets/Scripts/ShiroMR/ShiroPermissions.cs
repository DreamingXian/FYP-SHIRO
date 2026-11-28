// =============================================================================
// Project SHIRO - Meta Quest 3 Mixed Reality Client
// The "spatial data" permission (com.oculus.permission.USE_SCENE).
//
// As an app on the headset (APK), depth sensing (person detection and linking, 8D)
// works only after the wearer allows "spatial data". It is asked once when the app
// starts; the System tab shows the state and can ask again. Over the Quest Link
// cable the app runs on the computer and this permission does not apply (the Link
// app has its own "Spatial Data over Meta Quest Link" setting).
// =============================================================================
using System;
using UnityEngine;
#if UNITY_ANDROID
using UnityEngine.Android;
#endif

namespace ShiroMR
{
    public static class ShiroPermissions
    {
        public const string SpatialData = "com.oculus.permission.USE_SCENE";

        public enum State
        {
            /// <summary>Not an Android device (Quest Link, editor): nothing to ask.</summary>
            NotNeeded,
            Allowed,
            /// <summary>The question is on screen.</summary>
            Asking,
            /// <summary>Refused, or the question was closed without an answer.</summary>
            Refused
        }

        public static State SpatialDataState { get; private set; } = State.NotNeeded;

        /// <summary>Raised on the main thread when the state changes.</summary>
        public static event Action<State> OnChanged;

        /// <summary>How to allow it when the headset no longer asks (refused before).</summary>
        public const string HowToAllow = "Quest Settings → Privacy & safety → App permissions → Spatial data → turn on SHIRO MR, then restart the app.";

        private static float _nextCheck;

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        private static void AskAtStart()
        {
            Ask();
        }

        /// <summary>Asks for spatial data unless it is already allowed (or not needed here).</summary>
        public static void Ask()
        {
#if UNITY_ANDROID
            if (Application.platform != RuntimePlatform.Android)
            {
                Set(State.NotNeeded);
                return;
            }
            if (Permission.HasUserAuthorizedPermission(SpatialData))
            {
                Set(State.Allowed);
                return;
            }

            var callbacks = new PermissionCallbacks();
            callbacks.PermissionGranted += _ => Set(State.Allowed);
            callbacks.PermissionDenied += _ => Set(State.Refused);
            Set(State.Asking);
            Debug.Log($"[SHIRO PERMISSION] Asking for {SpatialData} (spatial data: depth sensing for person detection).");
            Permission.RequestUserPermission(SpatialData, callbacks);
#else
            Set(State.NotNeeded);
#endif
        }

        /// <summary>
        /// Reads the permission again (at most every 2 s) while it is not allowed: the question
        /// may have been closed without an answer. Call it from a regular update.
        /// </summary>
        public static void Recheck()
        {
#if UNITY_ANDROID
            if (SpatialDataState == State.Allowed || SpatialDataState == State.NotNeeded) return;
            if (Time.unscaledTime < _nextCheck) return;
            _nextCheck = Time.unscaledTime + 2f;
            if (Permission.HasUserAuthorizedPermission(SpatialData)) Set(State.Allowed);
#endif
        }

        /// <summary>A short label for the System tab.</summary>
        public static string Label()
        {
            switch (SpatialDataState)
            {
                case State.Allowed: return "🛡 Spatial data: ✅ allowed";
                case State.Asking: return "🛡 Spatial data: asking…";
                case State.Refused: return "🛡 Spatial data: ⚠ not allowed (tap)";
                default: return "🛡 Spatial data: via Quest Link";
            }
        }

        private static void Set(State state)
        {
            if (SpatialDataState == state) return;
            SpatialDataState = state;
            if (state == State.Refused) Debug.LogWarning($"[SHIRO PERMISSION] Spatial data not allowed: depth sensing and person linking stay off. {HowToAllow}");
            else Debug.Log($"[SHIRO PERMISSION] Spatial data: {state}.");
            OnChanged?.Invoke(state);
        }
    }
}
