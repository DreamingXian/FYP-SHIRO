// =============================================================================
// Project SHIRO - headset app version 2: a check that no text is cut
//
// In the Unity editor (and development builds) only: every 2 s it looks at the
// TextMeshPro text on screen and writes a warning to the Console once for each
// text that did not fit its box ("…" added or lines cut), with where it is:
//   [SHIRO v2 UI] Text cut: AlertCard/Mute/Label: "Sound on"
// So a layout problem shows up in the Console during a Link test, even when the
// screen moves on before anyone notices. Creates itself when the scene loads.
// =============================================================================
#if UNITY_EDITOR || DEVELOPMENT_BUILD
using System.Collections.Generic;
using TMPro;
using UnityEngine;

namespace ShiroMR.UI
{
    public class ShiroTextCheck : MonoBehaviour
    {
        private const float Every = 2f;
        private readonly HashSet<string> _reported = new HashSet<string>();
        private float _next;

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        private static void Bootstrap()
        {
            if (FindAnyObjectByType<ShiroTextCheck>() == null)
                new GameObject("ShiroTextCheck").AddComponent<ShiroTextCheck>();
        }

        private void Update()
        {
            if (Time.unscaledTime < _next) return;
            _next = Time.unscaledTime + Every;
            foreach (var t in FindObjectsByType<TextMeshProUGUI>(FindObjectsInactive.Exclude, FindObjectsSortMode.None))
            {
                string cut = Check(t);
                if (cut != null && _reported.Add(cut)) Debug.LogWarning($"[SHIRO v2 UI] Text cut: {cut}");
            }
        }

        /// <summary>"path: text" when this text did not fit its box, else null.</summary>
        public static string Check(TMP_Text t)
        {
            if (t == null || string.IsNullOrEmpty(t.text) || !t.isActiveAndEnabled) return null;
            if (!t.isTextTruncated && !t.isTextOverflowing) return null;
            return $"{Path(t.transform)}: \"{t.text.Replace("\n", " / ")}\"";
        }

        private static string Path(Transform t)
        {
            string p = t.name;
            for (int i = 0; i < 3 && t.parent != null; i++)
            {
                t = t.parent;
                p = t.name + "/" + p;
            }
            return p;
        }
    }
}
#endif
