// =============================================================================
// Project SHIRO - Meta Quest 3 Mixed Reality Client
// The edge server address typed on the hand slate (System → 🌐 Server address).
//
// As an app on the headset (APK) the edge server is the ward computer's address on
// the Wi-Fi, which the dashboard shows (ADMIN → Headset Pairing). Only digits and
// dots can be typed, so an IPv4 address is expected. Plain C# without Unity: it is
// tested outside Unity (Tests~/DetectionTests).
// =============================================================================
namespace ShiroMR.Net
{
    public static class ServerAddress
    {
        /// <summary>Longest IPv4 address: 255.255.255.255.</summary>
        public const int MaxLength = 15;

        public const string Backspace = "⌫";
        public const string Clear = "C";

        /// <summary>The text typed so far after one key of the address pad.</summary>
        public static string Press(string typed, string key)
        {
            typed = typed ?? "";
            if (key == Backspace) return typed.Length > 0 ? typed.Substring(0, typed.Length - 1) : typed;
            if (key == Clear) return "";
            if (key == ".")
            {
                // no dot first, no two dots in a row, at most three dots
                if (typed.Length == 0 || typed.EndsWith(".") || Count(typed, '.') >= 3) return typed;
                return typed + ".";
            }
            if (key == null || key.Length != 1 || key[0] < '0' || key[0] > '9') return typed;
            if (typed.Length >= MaxLength) return typed;
            int digitsInPart = typed.Length - typed.LastIndexOf('.') - 1;
            if (digitsInPart >= 3) return typed; // at most three digits per number
            return typed + key;
        }

        /// <summary>
        /// Null when the text is an address the headset can connect to; otherwise
        /// what is wrong with it, as a sentence for the clinician.
        /// </summary>
        public static string Problem(string text)
        {
            text = (text ?? "").Trim();
            if (text.Length == 0) return "Type the server address, for example 192.168.1.20.";

            string[] parts = text.Split('.');
            if (parts.Length != 4) return "An address has four numbers with dots between them, for example 192.168.1.20.";

            var numbers = new int[4];
            for (int i = 0; i < 4; i++)
            {
                string part = parts[i];
                if (part.Length == 0) return "A number is missing between two dots.";
                if (part.Length > 3) return $"{part} is too long: each number is 0 to 255.";
                foreach (char c in part)
                    if (c < '0' || c > '9') return "An address has only digits and dots.";
                if (part.Length > 1 && part[0] == '0') return $"Write {int.Parse(part)}, not {part} (no 0 in front).";
                numbers[i] = int.Parse(part);
                if (numbers[i] > 255) return $"{part} is too large: each number is 0 to 255.";
            }

            if (numbers[0] == 0) return "An address does not start with 0.";
            if (numbers[0] >= 224) return "This is not the address of a computer (group or broadcast address).";
            if (numbers[0] == 169 && numbers[1] == 254) return "169.254.x.x means the computer has no network. Connect it to the Wi-Fi first.";
            return null;
        }

        /// <summary>
        /// True for 127.x.x.x: the device the app runs on. Over the Quest Link cable that is
        /// the computer; as an app on the headset it is the headset itself.
        /// </summary>
        public static bool IsThisDevice(string text) => (text ?? "").Trim().StartsWith("127.");

        private static int Count(string text, char c)
        {
            int n = 0;
            foreach (char ch in text) if (ch == c) n++;
            return n;
        }
    }
}
