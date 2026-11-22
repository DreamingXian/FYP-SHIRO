// =============================================================================
// Project SHIRO - headset app version 2: the look of the new interface
//
// One place for colours and sizes, so every panel looks and reads the same and
// matches the web dashboard: blue for normal and for the main action, red for
// "needs help" and actions that cannot be undone, amber for "check", grey for
// "off". Panels are dark glass, readable over the passthrough view of a bright
// ward.
//
// Sizes are in canvas units of 1 mm (a panel's canvas is scaled 0.001 per unit;
// a panel read from further away scales up so it keeps the same size to the eye).
// Rules from Meta's hand-tracking guidance: buttons at least 22 mm, 12 mm apart.
// =============================================================================
using UnityEngine;

namespace ShiroMR.UI
{
    public static class ShiroTheme
    {
        // ----- Panels -----
        public static readonly Color Glass = new Color32(17, 24, 39, 236);          // panel background
        public static readonly Color GlassRaised = new Color32(31, 41, 55, 242);    // a card on a panel
        public static readonly Color GlassHover = new Color32(37, 52, 74, 245);     // a card under the finger or ray
        public static readonly Color Divider = new Color(1f, 1f, 1f, 0.10f);

        // ----- Text -----
        public static readonly Color Text = new Color32(243, 244, 246, 255);
        public static readonly Color TextDim = new Color32(165, 172, 184, 255);
        public static readonly Color TextOnColour = Color.white;

        // ----- Status (same meaning as on the web dashboard) -----
        public static readonly Color Alert = new Color32(220, 38, 38, 255);         // needs help
        public static readonly Color AlertDark = new Color32(127, 18, 24, 245);
        public static readonly Color AlertText = new Color32(252, 165, 165, 255);
        public static readonly Color Warn = new Color32(217, 119, 6, 255);          // check
        public static readonly Color WarnText = new Color32(252, 211, 77, 255);
        public static readonly Color Ok = new Color32(37, 99, 235, 255);            // normal
        public static readonly Color OkText = new Color32(147, 197, 253, 255);
        public static readonly Color Off = new Color32(148, 163, 184, 255);         // off, not heard
        public static readonly Color Good = new Color32(22, 163, 74, 255);          // done, answered
        public static readonly Color GoodText = new Color32(134, 239, 172, 255);

        // ----- Buttons -----
        public static readonly Color Primary = new Color32(37, 99, 235, 255);
        public static readonly Color PrimaryHover = new Color32(59, 130, 246, 255);
        public static readonly Color Danger = new Color32(220, 38, 38, 255);
        public static readonly Color DangerHover = new Color32(239, 68, 68, 255);
        public static readonly Color Secondary = new Color(1f, 1f, 1f, 0.12f);
        public static readonly Color SecondaryHover = new Color(1f, 1f, 1f, 0.22f);
        public static readonly Color Quiet = new Color(1f, 1f, 1f, 0f);
        public static readonly Color QuietHover = new Color(1f, 1f, 1f, 0.12f);
        public static readonly Color Pressed = new Color(1f, 1f, 1f, 0.35f);

        // ----- Sizes (canvas units = mm on a panel at its reference distance) -----
        public const float MinTarget = 22f;       // smallest button side
        public const float Gap = 12f;             // between buttons
        public const float Radius = 14f;          // panel corners
        public const float ButtonRadius = 10f;

        // Text sizes for a panel within reach (about 0.5 m)
        public const float TextSmall = 11f;
        public const float TextBody = 13f;
        public const float TextTitle = 18f;
        public const float TextBig = 26f;
    }
}
