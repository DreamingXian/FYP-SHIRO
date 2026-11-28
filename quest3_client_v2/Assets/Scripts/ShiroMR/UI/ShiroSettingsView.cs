// =============================================================================
// Project SHIRO - headset app version 2: Settings (stage 4)
//
// The ward panel's Settings page. It replaces the version 1 hand slate's Ward,
// System and Location tabs, so the slate is no longer opened:
//   Settings     - the ward and how it was found, in a card: found
//                  automatically (green), outside this ward, chosen by hand, or
//                  the room not set up on this headset (amber), with what that
//                  means; Room setup, Choose by hand, Automatic on / off; the
//                  connection; Server address, Pair headset, Advanced.
//   Room setup   - aligning the room to the ward plan at the door, in four
//                  numbered steps (stand, left side, right side, check and
//                  save), each ticked off as it is done. While pointing, the
//                  panel steps aside for a small bar above the view (the ward
//                  panel's AimBar), so the ray reaches the floor at the door.
//   Server address, Pair headset - keypads, as the version 1 pads.
//   Advanced     - the test tools: depth view, movement rule, person linking,
//                  test wristband, room outline, spatial data permission,
//                  clearing the saved alignment and quitting (both press twice).
//   Choose by hand - a ward this headset has not set up yet.
// =============================================================================
using System;
using System.Collections.Generic;
using System.Text;
using ShiroMR.Net;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

namespace ShiroMR.UI
{
    public class ShiroSettingsView
    {
        private const float W = ShiroWardPanel.W, Pad = ShiroWardPanel.Pad;
        private const float CW = W - 2 * Pad;
        private const float PageH = ShiroWardPanel.PageH;
        private const float ConfirmS = 4f;          // s a "press again" button waits for the second press

        internal enum View { Main = 0, ByHand = 1, RoomSetup = 2, Address = 3, Pairing = 4, Advanced = 5 }

        /// <summary>How the ward on show was found (the header's badge and the Settings card).</summary>
        internal enum WardMode { None, NotSetUp, Auto, Outside, ByHand }

        private readonly GameObject[] _views = new GameObject[6];
        private View _view = View.Main;
        private bool _subscribed;

        // Main
        private TextMeshProUGUI _wardName, _wardState, _wardHint, _connection;
        private Image _wardDot;
        private ShiroButton _setupBtn, _autoBtn;

        // Choose by hand
        private TextMeshProUGUI _listHeading;
        private readonly List<ShiroButton> _wardBtns = new List<ShiroButton>();
        private string _wardBtnsKey = "";

        // Room setup
        private TextMeshProUGUI _setupTitle, _setupStatus;
        private readonly Image[] _stepDots = new Image[4];
        private readonly TextMeshProUGUI[] _stepNums = new TextMeshProUGUI[4];
        private readonly TextMeshProUGUI[] _stepTexts = new TextMeshProUGUI[4];
        private ShiroButton _sideBtn, _saveBtn, _startBtn, _findBtn;
        private string _setupMsg;
        private Color _setupMsgColour;
        private float _calibratedAt = -1f, _savedAt = -1f;

        // Server address and pairing keypads
        private TextMeshProUGUI _addressText, _addressHint, _pairCode, _pairStatus;
        private ShiroButton _linkBtn;
        private string _addressTyped = "", _pairDigits = "";
        private bool _addressProblem;

        // Advanced
        private ShiroButton _depthBtn, _moveBtn, _linkingBtn, _fakeBtn, _outlineBtn, _permBtn, _clearBtn, _quitBtn;
        private TextMeshProUGUI _advStatus;
        private float _clearAskedAt = -100f, _quitAskedAt = -100f;

        // ----- Shared with the ward panel -----

        /// <summary>The room alignment waits for a point at the door frame (the panel steps aside).</summary>
        internal static bool IsAiming
        {
            get
            {
                var tool = WardAlignmentTool.Instance;
                if (tool == null) return false;
                var s = tool.currentStep;
                return s != AlignmentStep.Idle && s != AlignmentStep.Completed;
            }
        }

        /// <summary>What to do now while pointing (the aiming bar).</summary>
        internal static string AimingWords()
        {
            var tool = WardAlignmentTool.Instance;
            if (tool == null) return "";
            switch (tool.currentStep)
            {
                case AlignmentStep.AimingDoorLeft:
                    return "Step 2 of 4: point the ray at the floor at the LEFT side of the door frame, and pinch.";
                case AlignmentStep.AimingDoorRight:
                    return "Step 3 of 4: now at the RIGHT side of the door frame, and pinch.";
                default:
                    return "Room alignment: point and pinch.";
            }
        }

        internal static WardMode ModeOf(ShiroNetworkManager net)
        {
            if (net == null || !net.HasWard) return WardMode.None;
            var space = WardSpatialManager.Instance;
            if (space == null || !space.IsAligned) return WardMode.NotSetUp;
            var det = ShiroWardAutoDetect.Instance;
            if (det == null || !det.IsEnabled) return WardMode.ByHand;
            return ShiroWardPanel.WardFoundAutomatically() ? WardMode.Auto : WardMode.Outside;
        }

        /// <summary>The header's badge: its words and colour (null: no badge).</summary>
        internal static string BadgeWords(WardMode mode, out Color colour)
        {
            switch (mode)
            {
                case WardMode.Auto: colour = ShiroTheme.Good; return "Found automatically";
                case WardMode.NotSetUp: colour = ShiroTheme.Warn; return "Room not set up";
                case WardMode.Outside: colour = new Color(1f, 1f, 1f, 0.16f); return "Outside this ward";
                case WardMode.ByHand: colour = new Color(1f, 1f, 1f, 0.16f); return "Chosen by hand";
                default: colour = Color.clear; return null;
            }
        }

        // ----- Views -----

        internal void ShowView(View view)
        {
            _view = view;
            for (int i = 0; i < _views.Length; i++) _views[i].SetActive(i == (int)view);
            _wardBtnsKey = "";
            if (view == View.Address)
            {
                var net = ShiroNetworkManager.Instance;
                _addressTyped = net != null && !ServerAddress.IsThisDevice(net.serverIp) ? net.serverIp : "";
                _addressProblem = false;
                _addressHint.text = AddressHint();
            }
            if (view == View.Pairing) _pairDigits = "";
            Refresh();
        }

        internal void Refresh()
        {
            Subscribe();
            switch (_view)
            {
                case View.Main: RefreshMain(); break;
                case View.ByHand: RefreshByHand(); break;
                case View.RoomSetup: RefreshSetup(); break;
                case View.Address: RefreshAddress(); break;
                case View.Pairing: RefreshPairing(); break;
                case View.Advanced: RefreshAdvanced(); break;
            }
        }

        private void Subscribe()
        {
            if (_subscribed) return;
            var tool = WardAlignmentTool.Instance;
            if (tool == null) return;
            tool.OnAlignmentMessage += HandleToolMessage;
            tool.OnDoorAligned += HandleDoorAligned;
            tool.OnAnchorSaved += HandleAnchorSaved;
            _subscribed = true;
        }

        // ----- Main -----

        private void RefreshMain()
        {
            var net = ShiroNetworkManager.Instance;
            _wardName.text = ShiroWardPanel.WardTitle(net);
            var mode = ModeOf(net);
            Color dot;
            string state, hint;
            switch (mode)
            {
                case WardMode.Auto:
                    dot = ShiroTheme.Good; state = "Found automatically: you are inside this ward.";
                    hint = "Walk into another ward set up here and it switches by itself.";
                    break;
                case WardMode.NotSetUp:
                    dot = ShiroTheme.Warn; state = "The room is not set up on this headset yet.";
                    hint = "Set it up once: then tags stand in place and it is found by itself.";
                    break;
                case WardMode.Outside:
                    dot = ShiroTheme.Off; state = "You are not inside a ward set up on this headset.";
                    hint = "The last ward stays shown until you enter a ward set up here.";
                    break;
                case WardMode.ByHand:
                    dot = ShiroTheme.Off; state = "Chosen by hand: automatic is off.";
                    hint = "Turn Automatic on to switch wards as you walk in.";
                    break;
                default:
                    dot = ShiroTheme.Off; state = "No ward yet.";
                    hint = "Walk into a ward set up on this headset, or choose one by hand.";
                    break;
            }
            _wardDot.color = dot;
            _wardState.text = state;
            _wardState.color = mode == WardMode.Auto ? ShiroTheme.GoodText : mode == WardMode.NotSetUp ? ShiroTheme.WarnText : ShiroTheme.Text;
            _wardHint.text = hint;
            _setupBtn.SetKind(mode == WardMode.NotSetUp ? ButtonKind.Primary : ButtonKind.Secondary);
            var det = ShiroWardAutoDetect.Instance;
            _autoBtn.SetText(det != null && det.IsEnabled ? "Automatic: on" : "Automatic: off");
            _autoBtn.SetInteractable(det != null);

            if (net == null) { _connection.text = "Starting…"; return; }
            string where = $"{net.serverIp}:{net.serverPort}";
            string device = net.Identity != null ? net.Identity.DeviceId : "this headset";
            _connection.text = (net.IsConnected ? $"Connected to the edge server at {where}." : $"Not connected to the edge server at {where}.")
                + "\n" + (net.IsPaired ? $"{device} is paired." : $"{device} is not paired yet: Pair headset.");
            _connection.color = net.IsConnected && net.IsPaired ? ShiroTheme.Text : ShiroTheme.WarnText;
        }

        private void ToggleAuto()
        {
            var det = ShiroWardAutoDetect.Instance;
            if (det != null) det.SetEnabled(!det.IsEnabled);
            Refresh();
        }

        // ----- Choose by hand -----

        private void RefreshByHand()
        {
            var net = ShiroNetworkManager.Instance;
            var wards = new List<WardSummary>();
            if (net != null) foreach (var w in net.AvailableWards) if (w != null && !string.IsNullOrEmpty(w.ward_id)) wards.Add(w);
            ShowWards(wards, net != null ? net.targetWardId : "");
        }

        /// <summary>The wards to choose by hand (up to 9), the one shown highlighted. Also used by the preview tool.</summary>
        internal void ShowWards(List<WardSummary> wards, string active)
        {
            string key = active + "|";
            foreach (var w in wards) key += w.ward_id + ";";
            if (key == _wardBtnsKey) return;
            _wardBtnsKey = key;
            foreach (var b in _wardBtns) if (b != null) DestroyObject(b.gameObject);
            _wardBtns.Clear();

            Transform page = _views[(int)View.ByHand].transform;
            float bw = (CW - 2 * ShiroTheme.Gap) / 3f;
            int n = Mathf.Min(wards.Count, 9);
            for (int i = 0; i < n; i++)
            {
                var w = wards[i];
                string id = w.ward_id;
                bool shown = string.Equals(id, active, StringComparison.OrdinalIgnoreCase);
                string label = !string.IsNullOrEmpty(w.room_title) ? w.room_title : id;
                var b = ShiroUIKit.Button(page, $"Ward_{id}", label, shown ? ButtonKind.Primary : ButtonKind.Secondary, () => ChooseWard(id), 13f);
                if (b.Label != null) b.Label.fontSizeMin = 9f;   // long ward names shrink further
                ShiroUIKit.Place(b, Pad + (i % 3) * (bw + ShiroTheme.Gap), 54f + (i / 3) * 40f, bw, 32f);
                _wardBtns.Add(b);
            }
            _listHeading.text = wards.Count == 0 ? "The list of wards comes from the edge server (not connected?)."
                : wards.Count > 9 ? $"Choose the ward by hand (first 9 of {wards.Count})." : "Choose the ward by hand.";
        }

        private static void DestroyObject(GameObject go)
        {
            if (Application.isPlaying) UnityEngine.Object.Destroy(go);
            else UnityEngine.Object.DestroyImmediate(go);
        }

        private void ChooseWard(string id)
        {
            var net = ShiroNetworkManager.Instance;
            if (net != null) net.SwitchWard(id);
            ShowView(View.Main);
        }

        // ----- Room setup -----

        private void RefreshSetup()
        {
            var net = ShiroNetworkManager.Instance;
            var tool = WardAlignmentTool.Instance;
            var space = WardSpatialManager.Instance;
            string wardTitle = ShiroWardPanel.WardTitle(net);
            _setupTitle.text = $"Room setup: {wardTitle}";

            WardConfig ward = net != null && net.IsWardLoaded ? net.LastLoadedWardConfig : null;
            bool hasDoor = ward != null && ward.door != null;
            bool aligned = tool != null && tool.isAligned || space != null && space.IsAligned;
            string wardId = net != null ? net.targetWardId : "";
            bool savedAnchor = space != null && !string.IsNullOrEmpty(space.KnownAnchorUuid(wardId));
            bool unsaved = _calibratedAt > _savedAt;

            int step;
            if (tool != null && tool.currentStep == AlignmentStep.AimingDoorLeft) step = 1;
            else if (tool != null && tool.currentStep == AlignmentStep.AimingDoorRight) step = 2;
            else if (aligned && (unsaved || !savedAnchor)) step = 3;
            else if (aligned && savedAnchor) step = 4;   // all done
            else step = 0;
            SetSetupSteps(step, tool == null || tool.isInsideRoomLookingAtDoor);

            bool busy = step == 1 || step == 2;
            _saveBtn.SetInteractable(step == 3);
            _startBtn.SetText(aligned ? "Align again" : "Start");
            _startBtn.SetInteractable(!busy && hasDoor && tool != null);
            _findBtn.SetInteractable(!busy && tool != null && net != null && net.HasWard);
            _sideBtn.SetInteractable(!busy && tool != null);

            string msg;
            Color colour = ShiroTheme.Text;
            if (net == null || !net.HasWard) { msg = "No ward yet: choose one first (Settings, Choose by hand)."; colour = ShiroTheme.WarnText; }
            else if (ward == null) { msg = "Loading the ward from the edge server…"; colour = ShiroTheme.TextDim; }
            else if (!hasDoor) { msg = "This ward's plan has no door: add it on the dashboard (Wards and layout), then align here."; colour = ShiroTheme.WarnText; }
            else if (!string.IsNullOrEmpty(_setupMsg)) { msg = _setupMsg; colour = _setupMsgColour; }
            else if (step == 4) { msg = $"Done. This headset finds {wardTitle} by itself when you walk in, also after a restart."; colour = ShiroTheme.GoodText; }
            else if (step == 3) { msg = "Aligned. Check that the room's outline lines up with the walls and beds, then Save."; colour = ShiroTheme.OkText; }
            else msg = "Press Start, then point at the two sides of the door frame. It takes a few seconds.";
            _setupStatus.text = msg;
            _setupStatus.color = colour;
        }

        /// <summary>The four steps: done (green), now (blue), still to come (grey). Also used by the preview tool.</summary>
        internal void SetSetupSteps(int current, bool inside)
        {
            _stepTexts[0].text = inside ? "Stand inside the ward, facing the door." : "Stand in the hallway, facing into the ward through the door.";
            _sideBtn.SetText(inside ? "Inside ward" : "In hallway");
            for (int i = 0; i < 4; i++)
            {
                bool done = i < current, now = i == current;
                _stepDots[i].color = done ? ShiroTheme.Good : now ? ShiroTheme.Primary : new Color(1f, 1f, 1f, 0.14f);
                _stepNums[i].text = (i + 1).ToString();
                _stepTexts[i].color = now ? ShiroTheme.Text : done ? ShiroTheme.GoodText : ShiroTheme.TextDim;
            }
        }

        private void StartAlignment()
        {
            var tool = WardAlignmentTool.Instance;
            if (tool == null) return;
            _setupMsg = null;
            tool.StartDoorCalibration();
            Refresh();
        }

        private void ToggleSide()
        {
            var tool = WardAlignmentTool.Instance;
            if (tool == null) return;
            tool.isInsideRoomLookingAtDoor = !tool.isInsideRoomLookingAtDoor;
            Refresh();
        }

        private void SaveAlignment()
        {
            var tool = WardAlignmentTool.Instance;
            if (tool == null) return;
            _setupMsg = "Saving…";
            _setupMsgColour = ShiroTheme.TextDim;
            tool.SavePersistentAnchor();
            Refresh();
        }

        private void FindSaved()
        {
            var tool = WardAlignmentTool.Instance;
            if (tool == null) return;
            _setupMsg = null;
            tool.QuickReSync();
            Refresh();
        }

        private void HandleToolMessage(string text, Color colour)
        {
            _setupMsg = Clean(text);
            _setupMsgColour = colour;
        }

        private void HandleDoorAligned(bool ok, float measured, float expected)
        {
            if (!ok)
            {
                _setupMsg = "The two points were too close together. Press Start and point at both sides of the door frame.";
                _setupMsgColour = ShiroTheme.WarnText;
                return;
            }
            _calibratedAt = Time.time;
            if (Mathf.Abs(measured - expected) > 0.15f)
            {
                _setupMsg = $"Aligned, but the door measured {measured:0.00} m and the plan says {expected:0.00} m: Align again, pointing at the very sides of the frame.";
                _setupMsgColour = ShiroTheme.WarnText;
            }
            else
            {
                _setupMsg = $"Aligned: the door measured {measured:0.00} m (plan {expected:0.00} m). Check the room's outline, then Save.";
                _setupMsgColour = ShiroTheme.OkText;
            }
        }

        private void HandleAnchorSaved(bool ok)
        {
            if (!ok) return;   // the tool's own message says why
            _savedAt = Time.time;
            var net = ShiroNetworkManager.Instance;
            _setupMsg = $"Saved on this headset and on the edge server. This headset now finds {ShiroWardPanel.WardTitle(net)} by itself when you walk in.";
            _setupMsgColour = ShiroTheme.GoodText;
        }

        /// <summary>The alignment tool's messages without the symbols the font has no shapes for, in version 2's words.</summary>
        internal static string Clean(string text)
        {
            if (string.IsNullOrEmpty(text)) return text;
            var sb = new StringBuilder(text.Length);
            for (int i = 0; i < text.Length; i++)
            {
                char c = text[i];
                if (char.IsSurrogate(c) || c == '️' || c == '⚠' || c == '⏳' || c == '⚡' || c == '✅' || c == '❌' || c == '✓') continue;
                sb.Append(c);
            }
            return sb.ToString().Replace("(System tab)", "(Settings)").Replace("on the Ward tab", "in Settings")
                .Replace("press Re-Sync again", "press Find saved alignment again")
                .Replace("calibrate at the door frame and save a new anchor", "align again at the door and save")
                .Replace("Calibrate at the door frame", "Align at the door (Start)").Trim();
        }

        // ----- Server address -----

        private string AddressHint()
        {
            int port = ShiroNetworkManager.Instance != null ? ShiroNetworkManager.Instance.serverPort : 3000;
            return $"Shown on the dashboard under ADMIN, Headset Pairing (port {port}). The headset and the server computer must be on the same network.";
        }

        private void PressAddressKey(string key)
        {
            _addressTyped = ServerAddress.Press(_addressTyped, key);
            _addressProblem = false;
            _addressHint.text = AddressHint();
            Refresh();
        }

        private void ConnectToAddress()
        {
            string problem = ServerAddress.Problem(_addressTyped);
            if (problem != null) { _addressProblem = true; _addressHint.text = problem; Refresh(); return; }
            UseAddress(_addressTyped);
        }

        private void UseAddress(string address)
        {
            var net = ShiroNetworkManager.Instance;
            if (net == null) return;
            net.SetServerIp(address);
            _addressProblem = false;
            _addressHint.text = ServerAddress.IsThisDevice(address) && Application.platform == RuntimePlatform.Android
                ? $"Connecting to {address}: on the headset this is the headset itself, not the server computer."
                : $"Connecting to {address}:{net.serverPort}…";
            Refresh();
        }

        private void RefreshAddress()
        {
            _addressText.text = _addressTyped.Length > 0 ? _addressTyped : "_ . _ . _ . _";
            _addressText.color = _addressTyped.Length > 0 ? ShiroTheme.Text : ShiroTheme.TextDim;
            var net = ShiroNetworkManager.Instance;
            if (!_addressProblem && net != null && net.IsConnected && _addressHint.text.StartsWith("Connecting", StringComparison.Ordinal))
                _addressHint.text = $"Connected to the edge server at {net.serverIp}:{net.serverPort}.";
            _addressHint.color = _addressProblem ? ShiroTheme.WarnText
                : _addressHint.text.StartsWith("Connected", StringComparison.Ordinal) ? ShiroTheme.GoodText : ShiroTheme.TextDim;
        }

        // ----- Pairing -----

        private void PressPairKey(string key)
        {
            if (key == "Del") { if (_pairDigits.Length > 0) _pairDigits = _pairDigits.Substring(0, _pairDigits.Length - 1); }
            else if (key == "Clear") _pairDigits = "";
            else if (_pairDigits.Length < 6) _pairDigits += key;
            Refresh();
        }

        private void Pair()
        {
            var net = ShiroNetworkManager.Instance;
            if (net != null) net.Pair(_pairDigits);
            Refresh();
        }

        private void RefreshPairing()
        {
            var sb = new StringBuilder();
            for (int i = 0; i < 6; i++)
            {
                if (i > 0) sb.Append(' ');
                sb.Append(i < _pairDigits.Length ? _pairDigits[i] : '_');
            }
            _pairCode.text = sb.ToString();
            var net = ShiroNetworkManager.Instance;
            if (net == null) { _pairStatus.text = ""; return; }
            string device = net.Identity != null ? net.Identity.DeviceId : "This headset";
            _pairStatus.text = $"{device}, server {net.serverIp}:{net.serverPort}.\n{Clean(net.PairingMessage)}";
            _pairStatus.color = net.IsPaired ? ShiroTheme.GoodText : ShiroTheme.WarnText;
        }

        // ----- Advanced -----

        private void RefreshAdvanced()
        {
            var probe = ShiroDepthProbe.Instance;
            var link = ShiroPatientLinking.Instance;
            var twin = WardVisualizer.Instance;
            _depthBtn.SetText(probe != null && probe.IsRunning ? "Depth view: on" : "Depth view: off");
            _depthBtn.SetInteractable(probe != null);
            _moveBtn.SetText(probe != null && probe.MovementRequired ? "Move rule: on" : "Move rule: off");
            _moveBtn.SetInteractable(probe != null);
            _linkingBtn.SetText(link != null && link.LinkingEnabled ? "Person linking: on" : "Person linking: off");
            _linkingBtn.SetInteractable(link != null);
            _fakeBtn.SetText(link != null && link.FakeEnabled ? "Test wristband: on" : "Test wristband: off");
            _fakeBtn.SetInteractable(link != null);
            _outlineBtn.SetText(twin != null && twin.showDigitalTwinOverlay ? "Room outline: on" : "Room outline: off");
            _outlineBtn.SetInteractable(twin != null);
            _permBtn.SetText(PermissionWords());
            bool clearAsked = Time.time - _clearAskedAt < ConfirmS, quitAsked = Time.time - _quitAskedAt < ConfirmS;
            _clearBtn.SetText(clearAsked ? "Press again to clear" : "Clear saved alignment");
            _quitBtn.SetText(quitAsked ? "Press again to quit" : "Quit the app");
        }

        private static string PermissionWords()
        {
            switch (ShiroPermissions.SpatialDataState)
            {
                case ShiroPermissions.State.Allowed: return "Spatial data: allowed";
                case ShiroPermissions.State.Asking: return "Spatial data: asking…";
                case ShiroPermissions.State.Refused: return "Spatial data: not allowed";
                default: return "Spatial data: via Link";
            }
        }

        private void AskPermission()
        {
            if (ShiroPermissions.SpatialDataState == ShiroPermissions.State.Refused)
                Status($"If no question appears: {ShiroPermissions.HowToAllow.Replace(" → ", ", ")}");   // no "→" in the font
            ShiroPermissions.Ask();
            Refresh();
        }

        private void ClearAlignment()
        {
            if (Time.time - _clearAskedAt > ConfirmS) { _clearAskedAt = Time.time; Refresh(); return; }
            _clearAskedAt = -100f;
            var tool = WardAlignmentTool.Instance;
            if (tool != null) tool.PurgeAnchorAndResetAlignment();
            _calibratedAt = _savedAt = -1f;
            _setupMsg = null;
            Status("The saved alignment of this ward was cleared on this headset and the edge server. Set up the room again (Room setup).");
            Refresh();
        }

        private void QuitApp()
        {
            if (Time.time - _quitAskedAt > ConfirmS) { _quitAskedAt = Time.time; Status(Application.isEditor ? "Over Quest Link this stops Play mode." : "Alerts and vital signs stop on this headset until the app is opened again."); Refresh(); return; }
            Debug.Log("[SHIRO APP] Quit from the ward panel (Settings, Advanced).");
#if UNITY_EDITOR
            UnityEditor.EditorApplication.isPlaying = false;
#else
            Application.Quit();
#endif
        }

        private void Status(string text)
        {
            _advStatus.text = text;
        }

        // ----- Building -----

        internal void Build(Transform page, ShiroWardPanel panel)
        {
            for (int i = 0; i < _views.Length; i++)
            {
                _views[i] = new GameObject(((View)i).ToString(), typeof(RectTransform));
                _views[i].transform.SetParent(page, false);
                ShiroUIKit.Fill(_views[i].transform as RectTransform);
            }
            BuildMain(_views[(int)View.Main].transform);
            BuildByHand(_views[(int)View.ByHand].transform);
            BuildSetup(_views[(int)View.RoomSetup].transform);
            BuildAddress(_views[(int)View.Address].transform);
            BuildPairing(_views[(int)View.Pairing].transform);
            BuildAdvanced(_views[(int)View.Advanced].transform);
            for (int i = 0; i < _views.Length; i++) _views[i].SetActive(i == 0);
        }

        private ShiroButton Btn(Transform parent, string name, string label, ButtonKind kind, Action onClick, float x, float y, float w, float h = 30f, float size = 13f)
        {
            var b = ShiroUIKit.Button(parent, name, label, kind, onClick, size);
            ShiroUIKit.Place(b, x, y, w, h);
            return b;
        }

        private void BuildMain(Transform m)
        {
            // The ward: how it was found and what that means
            var card = ShiroUIKit.Panel(m, "WardCard", ShiroTheme.GlassRaised, 10f);
            ShiroUIKit.Place(card, Pad, 0, CW, 92);
            Transform c = card.transform;
            var heading = ShiroUIKit.Label(c, "Heading", "Ward", 11f, ShiroTheme.TextDim);
            ShiroUIKit.Place(heading, 12, 5, 120, 14);
            _wardName = ShiroUIKit.Label(c, "WardName", "", 17f, ShiroTheme.Text, FontStyles.Bold).Fit(11f);
            ShiroUIKit.Place(_wardName, 12, 19, CW - 24, 24);
            _wardDot = ShiroUIKit.Dot(c, "StateDot", ShiroTheme.Off);
            ShiroUIKit.Place(_wardDot, 12, 50, 10, 10);
            _wardState = ShiroUIKit.Label(c, "State", "", 12.5f, ShiroTheme.Text, FontStyles.Bold).Fit(9f);
            ShiroUIKit.Place(_wardState, 28, 46, CW - 40, 18);
            _wardHint = ShiroUIKit.Label(c, "Hint", "", 11f, ShiroTheme.TextDim).Fit(8f);
            ShiroUIKit.Place(_wardHint, 12, 68, CW - 24, 18);

            float bw = (CW - 2 * 8f) / 3f;
            _setupBtn = Btn(m, "RoomSetup", "Room setup", ButtonKind.Secondary, () => ShowView(View.RoomSetup), Pad, 100, bw);
            Btn(m, "ChooseByHand", "Choose by hand", ButtonKind.Secondary, () => ShowView(View.ByHand), Pad + bw + 8f, 100, bw);
            _autoBtn = Btn(m, "Automatic", "Automatic: on", ButtonKind.Secondary, ToggleAuto, Pad + 2 * (bw + 8f), 100, bw);

            // The connection
            var conn = ShiroUIKit.Panel(m, "ConnectionCard", ShiroTheme.GlassRaised, 10f);
            ShiroUIKit.Place(conn, Pad, 140, CW, 52);
            var connHeading = ShiroUIKit.Label(conn.transform, "Heading", "Connection", 11f, ShiroTheme.TextDim);
            ShiroUIKit.Place(connHeading, 12, 4, 120, 14);
            _connection = ShiroUIKit.Label(conn.transform, "Connection", "", 12f, ShiroTheme.Text, FontStyles.Normal, TextAlignmentOptions.TopLeft, true).Fit(9f);
            ShiroUIKit.Place(_connection, 12, 18, CW - 24, 32);

            Btn(m, "ServerAddress", "Server address", ButtonKind.Secondary, () => ShowView(View.Address), Pad, 200, bw);
            Btn(m, "PairHeadset", "Pair headset", ButtonKind.Secondary, () => ShowView(View.Pairing), Pad + bw + 8f, 200, bw);
            Btn(m, "Advanced", "Advanced", ButtonKind.Secondary, () => ShowView(View.Advanced), Pad + 2 * (bw + 8f), 200, bw);
        }

        private void BuildByHand(Transform l)
        {
            _listHeading = ShiroUIKit.Label(l, "ListHeading", "Choose the ward by hand.", 14f, ShiroTheme.Text, FontStyles.Bold).Fit(10f);
            ShiroUIKit.Place(_listHeading, Pad, 0, CW, 20);
            var note = ShiroUIKit.Label(l, "ListNote",
                "Only for a ward this headset has not set up yet: a ward that is set up is found automatically when you walk in.",
                12f, ShiroTheme.TextDim, FontStyles.Normal, TextAlignmentOptions.TopLeft, true).Fit(9f);
            ShiroUIKit.Place(note, Pad, 21, CW, 30);
            float bw = (CW - 8f) / 2f;
            Btn(l, "Back", "‹ Back", ButtonKind.Secondary, () => ShowView(View.Main), Pad, 200, bw);
            Btn(l, "RoomSetup", "Room setup", ButtonKind.Secondary, () => ShowView(View.RoomSetup), Pad + bw + 8f, 200, bw);
        }

        private void BuildSetup(Transform s)
        {
            _setupTitle = ShiroUIKit.Label(s, "Title", "Room setup", 14f, ShiroTheme.Text, FontStyles.Bold).Fit(10f);
            ShiroUIKit.Place(_setupTitle, Pad, 0, CW, 20);
            string[] steps =
            {
                "Stand inside the ward, facing the door.",
                "Point the ray at the floor at the left side of the door frame, and pinch.",
                "Then at the right side of the door frame, and pinch.",
                "Check that the room's outline lines up, then save."
            };
            const float rowH = 30f, rightW = 100f;
            for (int i = 0; i < 4; i++)
            {
                float y = 25f + i * 34f;
                _stepDots[i] = ShiroUIKit.Dot(s, $"Step{i + 1}", ShiroTheme.Primary);
                ShiroUIKit.Place(_stepDots[i], Pad, y + 4f, 22, 22);
                _stepNums[i] = ShiroUIKit.Label(_stepDots[i].transform, "Number", (i + 1).ToString(), 12f, Color.white, FontStyles.Bold, TextAlignmentOptions.Center);
                ShiroUIKit.Fill(_stepNums[i]);
                bool hasButton = i == 0 || i == 3;
                _stepTexts[i] = ShiroUIKit.Label(s, $"StepText{i + 1}", steps[i], 12f, ShiroTheme.Text, FontStyles.Normal, TextAlignmentOptions.Left, true).Fit(9f);
                ShiroUIKit.Place(_stepTexts[i], Pad + 30f, y, CW - 30f - (hasButton ? rightW + 8f : 0f), rowH);
            }
            _sideBtn = Btn(s, "Side", "Inside ward", ButtonKind.Secondary, ToggleSide, Pad + CW - rightW, 25f, rightW, rowH, 12f);
            _saveBtn = Btn(s, "Save", "Save", ButtonKind.Primary, SaveAlignment, Pad + CW - rightW, 25f + 3 * 34f, rightW, rowH, 13f);

            _setupStatus = ShiroUIKit.Label(s, "Status", "", 12f, ShiroTheme.Text, FontStyles.Normal, TextAlignmentOptions.TopLeft, true).Fit(9f);
            ShiroUIKit.Place(_setupStatus, Pad, 160, CW, 40);

            Btn(s, "Back", "‹ Back", ButtonKind.Secondary, () => ShowView(View.Main), Pad, 202, 80, 28);
            _startBtn = Btn(s, "Start", "Start", ButtonKind.Primary, StartAlignment, Pad + 88, 202, 128, 28);
            _findBtn = Btn(s, "FindSaved", "Find saved alignment", ButtonKind.Secondary, FindSaved, Pad + 224, 202, CW - 224, 28, 12f);
        }

        /// <summary>A 3 × 4 keypad at (x, y): keys 70 × 30 mm.</summary>
        private void Keypad(Transform parent, string[] keys, Action<string> press, float x, float y)
        {
            for (int i = 0; i < keys.Length; i++)
            {
                string key = keys[i];
                Btn(parent, $"Key_{i}", key, ButtonKind.Secondary, () => press(key), x + (i % 3) * 76f, y + (i / 3) * 34f, 70, 30, 14f);
            }
        }

        private void BuildAddress(Transform a)
        {
            var title = ShiroUIKit.Label(a, "Title", "Edge server address", 14f, ShiroTheme.Text, FontStyles.Bold);
            ShiroUIKit.Place(title, Pad, 0, CW, 18);
            _addressHint = ShiroUIKit.Label(a, "Hint", "", 11f, ShiroTheme.TextDim, FontStyles.Normal, TextAlignmentOptions.TopLeft, true).Fit(8f);
            ShiroUIKit.Place(_addressHint, Pad, 19, CW, 28);
            var field = ShiroUIKit.Panel(a, "Field", ShiroTheme.GlassRaised, 8f);
            ShiroUIKit.Place(field, Pad, 50, 222, 32);
            _addressText = ShiroUIKit.Label(field.transform, "Typed", "", 20f, ShiroTheme.Text, FontStyles.Bold, TextAlignmentOptions.Center).Fit(12f);
            ShiroUIKit.Fill(_addressText, 3f);
            // The version 1 keys; backspace written as a word (the font has no "⌫")
            Keypad(a, new[] { "1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "Del" },
                k => PressAddressKey(k == "Del" ? ServerAddress.Backspace : k), Pad, 88);
            float rx = Pad + 232f, rw = CW - 232f;
            Btn(a, "Connect", "Connect", ButtonKind.Primary, ConnectToAddress, rx, 50, rw, 32);
            Btn(a, "Clear", "Clear", ButtonKind.Secondary, () => PressAddressKey(ServerAddress.Clear), rx, 88, rw);
            // Over Quest Link the edge server runs on the same computer (editor only)
            _linkBtn = Btn(a, "QuestLink", "This PC (Link)", ButtonKind.Secondary, () => UseAddress("127.0.0.1"), rx, 122, rw);
            _linkBtn.gameObject.SetActive(Application.isEditor);
            Btn(a, "Reconnect", "Reconnect", ButtonKind.Secondary, () =>
            {
                var net = ShiroNetworkManager.Instance;
                if (net != null) net.Connect();
            }, rx, 156, rw);
            Btn(a, "Back", "‹ Back", ButtonKind.Secondary, () => ShowView(View.Main), rx, 190, rw, 32);
        }

        private void BuildPairing(Transform p)
        {
            var title = ShiroUIKit.Label(p, "Title", "Pair this headset", 14f, ShiroTheme.Text, FontStyles.Bold);
            ShiroUIKit.Place(title, Pad, 0, CW, 18);
            var hint = ShiroUIKit.Label(p, "Hint", "Type the 6-digit code shown on the dashboard under ADMIN, Headset Pairing.",
                11f, ShiroTheme.TextDim, FontStyles.Normal, TextAlignmentOptions.TopLeft, true).Fit(8f);
            ShiroUIKit.Place(hint, Pad, 19, CW, 28);
            var field = ShiroUIKit.Panel(p, "Field", ShiroTheme.GlassRaised, 8f);
            ShiroUIKit.Place(field, Pad, 50, 222, 32);
            _pairCode = ShiroUIKit.Label(field.transform, "Code", "", 22f, ShiroTheme.Text, FontStyles.Bold, TextAlignmentOptions.Center).Fit(12f);
            ShiroUIKit.Fill(_pairCode, 3f);
            Keypad(p, new[] { "1", "2", "3", "4", "5", "6", "7", "8", "9", "Clear", "0", "Del" }, PressPairKey, Pad, 88);
            float rx = Pad + 232f, rw = CW - 232f;
            Btn(p, "Pair", "Pair", ButtonKind.Primary, Pair, rx, 50, rw, 32);
            _pairStatus = ShiroUIKit.Label(p, "Status", "", 11f, ShiroTheme.TextDim, FontStyles.Normal, TextAlignmentOptions.TopLeft, true).Fit(8f);
            ShiroUIKit.Place(_pairStatus, rx, 88, rw, 96);
            Btn(p, "Back", "‹ Back", ButtonKind.Secondary, () => ShowView(View.Main), rx, 190, rw, 32);
        }

        private void BuildAdvanced(Transform a)
        {
            var title = ShiroUIKit.Label(a, "Title", "Advanced: test tools", 14f, ShiroTheme.Text, FontStyles.Bold);
            ShiroUIKit.Place(title, Pad, 0, CW, 18);
            var note = ShiroUIKit.Label(a, "Note", "For testing person detection and the room alignment. In normal use, leave them as they are.",
                11f, ShiroTheme.TextDim, FontStyles.Normal, TextAlignmentOptions.TopLeft, true).Fit(8f);
            ShiroUIKit.Place(note, Pad, 19, CW, 28);
            float bw = (CW - 8f) / 2f, x2 = Pad + bw + 8f;
            _depthBtn = Btn(a, "DepthView", "Depth view: off", ButtonKind.Secondary, () =>
            {
                var probe = ShiroDepthProbe.Instance;
                if (probe != null) probe.SetRunning(!probe.IsRunning);
                Refresh();
            }, Pad, 50, bw);
            _moveBtn = Btn(a, "MoveRule", "Move rule: on", ButtonKind.Secondary, () =>
            {
                var probe = ShiroDepthProbe.Instance;
                if (probe != null) probe.SetMovementRequired(!probe.MovementRequired);
                Refresh();
            }, x2, 50, bw);
            _linkingBtn = Btn(a, "PersonLinking", "Person linking: off", ButtonKind.Secondary, () =>
            {
                var link = ShiroPatientLinking.Instance;
                if (link != null) link.SetLinkingEnabled(!link.LinkingEnabled);
                Refresh();
            }, Pad, 86, bw);
            _fakeBtn = Btn(a, "TestWristband", "Test wristband: off", ButtonKind.Secondary, () =>
            {
                var link = ShiroPatientLinking.Instance;
                if (link != null) link.SetFakeEnabled(!link.FakeEnabled);
                Refresh();
            }, x2, 86, bw);
            _outlineBtn = Btn(a, "RoomOutline", "Room outline: on", ButtonKind.Secondary, () =>
            {
                var twin = WardVisualizer.Instance;
                if (twin != null) twin.ToggleOverlay(!twin.showDigitalTwinOverlay);
                Refresh();
            }, Pad, 122, bw);
            _permBtn = Btn(a, "SpatialData", "Spatial data", ButtonKind.Secondary, AskPermission, x2, 122, bw);
            _clearBtn = Btn(a, "ClearAlignment", "Clear saved alignment", ButtonKind.Danger, ClearAlignment, Pad, 158, bw);
            _quitBtn = Btn(a, "Quit", "Quit the app", ButtonKind.Danger, QuitApp, x2, 158, bw);
            Btn(a, "Back", "‹ Back", ButtonKind.Secondary, () => ShowView(View.Main), Pad, 200, 80, 30);
            _advStatus = ShiroUIKit.Label(a, "Status", "", 11f, ShiroTheme.WarnText, FontStyles.Normal, TextAlignmentOptions.TopLeft, true).Fit(8f);
            ShiroUIKit.Place(_advStatus, Pad + 90f, 196, CW - 90f, 36);
        }
    }
}
