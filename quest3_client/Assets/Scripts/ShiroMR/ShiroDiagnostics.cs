// =============================================================================
// Project SHIRO - Meta Quest 3 Mixed Reality Client
// Diagnostics helpers: logging of caught exceptions, and this headset's identity
// =============================================================================
using System;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text;
using UnityEngine;

namespace ShiroMR
{
    /// <summary>
    /// Logs exceptions that are caught on purpose (for example a Meta SDK call
    /// that fails every frame when the headset runtime is not available).
    /// Each place is logged the first time, then at most once a minute with the
    /// number of repeats, so the console shows the problem without flooding.
    /// Safe to call from background threads.
    /// </summary>
    public static class ShiroLog
    {
        private const float RepeatIntervalSeconds = 60f;
        private static readonly object Gate = new object();
        private static readonly Dictionary<string, (DateTime last, int suppressed)> Seen = new Dictionary<string, (DateTime, int)>();

        public static void Caught(string where, Exception ex)
        {
            if (ex == null) return;
            string message;
            lock (Gate)
            {
                DateTime now = DateTime.UtcNow;
                if (Seen.TryGetValue(where, out var entry) && (now - entry.last).TotalSeconds < RepeatIntervalSeconds)
                {
                    Seen[where] = (entry.last, entry.suppressed + 1);
                    return;
                }
                int repeats = entry.suppressed;
                Seen[where] = (now, 0);
                message = repeats > 0
                    ? $"[SHIRO] {where}: {ex.GetType().Name}: {ex.Message} (also {repeats} time(s) in the last minute)"
                    : $"[SHIRO] {where}: {ex.GetType().Name}: {ex.Message}";
            }
            Debug.LogWarning(message);
        }
    }

    /// <summary>
    /// Identity of this headset towards the edge server. Each headset gets its
    /// own device ID and an artificial MAC address, both derived from the
    /// device's unique identifier, so two headsets never share an identity.
    /// Quest 3 does not expose its real Wi-Fi MAC address to apps; the derived
    /// address is marked as locally administered (second-lowest bit of the first
    /// byte set), so it can never equal a real hardware address.
    /// Must be created on the Unity main thread (SystemInfo).
    /// </summary>
    public sealed class HeadsetIdentity
    {
        private const string FallbackKey = "Shiro_HeadsetInstallId";

        public string DeviceId { get; }
        public string MacAddress { get; }

        private HeadsetIdentity(string deviceId, string macAddress)
        {
            DeviceId = deviceId;
            MacAddress = macAddress;
        }

        public static HeadsetIdentity Create()
        {
            string source = SystemInfo.deviceUniqueIdentifier;
            if (string.IsNullOrEmpty(source) || source == SystemInfo.unsupportedIdentifier)
            {
                // No device identifier on this platform: one random ID per installation
                source = PlayerPrefs.GetString(FallbackKey, "");
                if (string.IsNullOrEmpty(source))
                {
                    source = Guid.NewGuid().ToString("N");
                    PlayerPrefs.SetString(FallbackKey, source);
                    PlayerPrefs.Save();
                }
            }

            byte[] hash;
            using (var sha = SHA256.Create())
            {
                hash = sha.ComputeHash(Encoding.UTF8.GetBytes("SHIRO-HEADSET:" + source));
            }

            string deviceId = "QUEST3-" + BitConverter.ToString(hash, 0, 3).Replace("-", "");
            byte first = (byte)((hash[3] & 0xFC) | 0x02); // unicast, locally administered
            string mac = $"{first:X2}:{hash[4]:X2}:{hash[5]:X2}:{hash[6]:X2}:{hash[7]:X2}:{hash[8]:X2}";
            return new HeadsetIdentity(deviceId, mac);
        }
    }
}
