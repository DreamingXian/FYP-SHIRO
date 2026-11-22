// =============================================================================
// Project SHIRO - headset app version 2: the click of the new interface
// A short tone made in code (no sound file), played for every button press.
// =============================================================================
using UnityEngine;

namespace ShiroMR.UI
{
    public static class ShiroUISound
    {
        private static AudioSource _source;
        private static AudioClip _click;

        public static void Click()
        {
            if (_source == null) Create();
            if (_source != null && _click != null) _source.PlayOneShot(_click, 0.4f);
        }

        private static void Create()
        {
            var go = new GameObject("ShiroUISound");
            Object.DontDestroyOnLoad(go);
            _source = go.AddComponent<AudioSource>();
            _source.playOnAwake = false;
            _source.spatialBlend = 0f;

            const int rate = 44100;
            int n = Mathf.RoundToInt(rate * 0.035f);
            var samples = new float[n];
            for (int i = 0; i < n; i++)
            {
                float t = (float)i / rate;
                samples[i] = Mathf.Sin(2f * Mathf.PI * 1400f * t) * Mathf.Exp(-t * 120f) * 0.45f;
            }
            _click = AudioClip.Create("ShiroUIClick", n, 1, rate, false);
            _click.SetData(samples, 0);
        }
    }
}
