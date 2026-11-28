// =============================================================================
// Project SHIRO - headset app version 2: the wrist chip
//
// A small chip on the left wrist while the ward panel is closed: the connection
// (a dot: green connected, amber not paired or no ward, grey not connected) and
// the ward's name; red and blinking with the number of alerts waiting. A tap
// opens the alert card when an alert waits, else the ward panel. It replaces
// the wrist badge of version 1 (same place on the wrist). When the headset switches
// ward by itself (it walked into another ward set up on it), the chip turns green
// with the new ward's name for a few seconds.
// Creates itself when the scene loads.
// =============================================================================
using TMPro;
using UnityEngine;
using UnityEngine.UI;

namespace ShiroMR.UI
{
    public class ShiroWristChip : MonoBehaviour
    {
        public static ShiroWristChip Instance { get; private set; }

        private const float W = 120f, H = 30f;   // mm (Meta: at least 22 mm to touch)

        private Canvas _canvas;
        private ShiroButton _button;
        private Image _dot;
        private TextMeshProUGUI _text;
        private Transform _head;
        private Transform _leftController;
        private float _refreshIn;
        private bool _detectSubscribed;
        private float _wardFlashUntil = -1f;

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        private static void Bootstrap()
        {
            if (Instance == null && FindAnyObjectByType<ShiroWristChip>() == null)
                new GameObject("ShiroWristChip").AddComponent<ShiroWristChip>();
        }

        private void Awake()
        {
            if (Instance != null && Instance != this) { Destroy(gameObject); return; }
            Instance = this;
            Build();
        }

        private void Build()
        {
            _canvas = ShiroUIKit.WorldCanvas("WristChip", transform, new Vector2(W, H));
            _button = ShiroUIKit.Button(_canvas.transform, "Chip", null, ButtonKind.Surface, Tapped);
            ShiroUIKit.Fill(_button);
            ShiroUIKit.SetRadius(_button.Background, H / 2f);
            _dot = ShiroUIKit.Dot(_button.transform, "Dot", ShiroTheme.Off);
            ShiroUIKit.Place(_dot, 12, (H - 9) / 2f, 9, 9);
            _text = ShiroUIKit.Label(_button.transform, "Text", "Menu", 13f, ShiroTheme.Text, FontStyles.Bold).Fit(9f);
            ShiroUIKit.Place(_text, 27, 5, W - 27 - 10, H - 10);
            _canvas.gameObject.SetActive(false);
        }

        private void Tapped()
        {
            var am = ShiroAlertManager.Instance;
            if (am != null && am.Current != null && am.PendingCount > 0 && ShiroAlertCard.Instance != null) ShiroAlertCard.Instance.Open();
            else if (ShiroWardPanel.Instance != null) ShiroWardPanel.Instance.Open();
        }

        private void LateUpdate()
        {
            if (_head == null && Camera.main != null) _head = Camera.main.transform;
            if (!_detectSubscribed && ShiroWardAutoDetect.Instance != null)
            {
                ShiroWardAutoDetect.Instance.OnWardDetected += _ => { _wardFlashUntil = Time.time + 6f; _refreshIn = 0f; };
                _detectSubscribed = true;
            }
            bool panelOpen = ShiroWardPanel.Instance != null && ShiroWardPanel.Instance.IsOpen;
            bool oldMenuOpen = ShiroHandSlate.Instance != null && ShiroHandSlate.Instance.isSlateVisible;
            bool show = _head != null && !panelOpen && !oldMenuOpen && TryGetWrist(out Vector3 pos, out Quaternion rot)
                        && Place(pos, rot);
            if (_canvas.gameObject.activeSelf != show) _canvas.gameObject.SetActive(show);
            if (!show) return;

            // Alerts waiting: red, blinking
            var am = ShiroAlertManager.Instance;
            int pending = am != null ? am.PendingCount : 0;
            if (pending > 0)
            {
                bool on = Mathf.Repeat(Time.time, 0.8f) < 0.4f;
                _button.SetColorOverride(on ? ShiroTheme.Alert : ShiroTheme.AlertDark);
            }
            else if (Time.time < _wardFlashUntil) _button.SetColorOverride(ShiroTheme.Good);   // a new ward, found automatically
            else _button.SetColorOverride(null);

            _refreshIn -= Time.deltaTime;
            if (_refreshIn > 0f) return;
            _refreshIn = 0.5f;
            var net = ShiroNetworkManager.Instance;
            ShiroWardPanel.StatusWords(net, out Color dot);
            _dot.color = pending > 0 || Time.time < _wardFlashUntil ? Color.white : dot;
            if (pending > 0) _text.text = pending == 1 ? "1 alert" : $"{pending} alerts";
            else if (net != null && net.HasWard)
            {
                var ward = net.LastLoadedWardConfig;
                _text.text = ward != null && !string.IsNullOrEmpty(ward.room_title) &&
                             string.Equals(ward.ward_id, net.targetWardId, System.StringComparison.OrdinalIgnoreCase)
                    ? ward.room_title : net.targetWardId;
            }
            else _text.text = "Menu";
        }

        /// <summary>The left wrist: the hand, else the left controller, else (editor without either) low left in view.</summary>
        private bool TryGetWrist(out Vector3 pos, out Quaternion rot)
        {
            var hands = ShiroHandVisualizer.Instance;
            if (hands != null && hands.IsLeftHandTracked)
            {
                pos = hands.LeftWristPosition;
                rot = hands.LeftWristRotation;
                return true;
            }
            if (_leftController == null) { var go = GameObject.Find("LeftControllerAnchor"); if (go != null) _leftController = go.transform; }
            bool controller = false;
            try { controller = OVRInput.IsControllerConnected(OVRInput.Controller.LTouch); }
            catch { controller = false; }
            if (controller && _leftController != null && _leftController.gameObject.activeInHierarchy)
            {
                pos = _leftController.position;
                rot = _leftController.rotation;
                return true;
            }
            if (Application.isEditor && _head != null)
            {
                pos = _head.position + _head.forward * 0.45f - _head.right * 0.16f - _head.up * 0.12f;
                rot = _head.rotation;
                return true;
            }
            pos = Vector3.zero;
            rot = Quaternion.identity;
            return false;
        }

        /// <summary>On the wrist (as the version 1 badge), facing the eyes.</summary>
        private bool Place(Vector3 wristPos, Quaternion wristRot)
        {
            Vector3 p = wristPos + wristRot * new Vector3(0f, 0.04f, 0.02f);
            Vector3 look = p - _head.position;
            if (look.sqrMagnitude < 1e-4f) return false;
            _canvas.transform.SetPositionAndRotation(p, Quaternion.LookRotation(look.normalized, Vector3.up));
            return true;
        }
    }
}
