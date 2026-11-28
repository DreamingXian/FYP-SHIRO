// =============================================================================
// Project SHIRO - Meta Quest 3 Mixed Reality Client
// Materials for objects the app makes while it runs (beds, door frames, markers)
// =============================================================================
using System.Collections.Generic;
using UnityEngine;

namespace ShiroMR
{
    /// <summary>
    /// Materials for objects made by code (GameObject.CreatePrimitive and similar).
    ///
    /// Why this exists: inside the Unity editor (Quest Link), CreatePrimitive gives a
    /// new object URP's default Lit material. That default exists only in the editor;
    /// in the APK the object gets Unity's old built-in material, which URP cannot
    /// draw, so it shows magenta. A shader looked up only by name (Shader.Find) is
    /// left out of the APK too, unless something else in the build uses it.
    ///
    /// The two template materials in Assets/Resources/ShiroMR always go into the APK
    /// (Unity packs everything under a Resources folder), so objects made from them
    /// look the same over Quest Link and in the APK:
    ///   ShiroSolid   - URP Lit, opaque: what CreatePrimitive gives in the editor.
    ///   ShiroOverlay - URP Unlit, opaque: flat colour without light and shadow.
    ///
    /// Rule for new code: never leave a CreatePrimitive object with its default
    /// material and never Shader.Find a URP shader; use Paint, Solid or OverlayShader.
    /// "Sprites/Default" is also safe (Project Settings → Graphics → Always Included).
    /// SHIRO → Check APK build settings checks that both templates are in place.
    /// </summary>
    public static class ShiroMaterials
    {
        public const string SolidResource = "ShiroMR/ShiroSolid";
        public const string SolidShaderName = "Universal Render Pipeline/Lit";
        public const string OverlayResource = "ShiroMR/ShiroOverlay";
        public const string OverlayShaderName = "Universal Render Pipeline/Unlit";
        private const string SafeShaderName = "Sprites/Default";

        private static Material _solidTemplate;
        private static Material _overlayTemplate;
        private static readonly Dictionary<Color, Material> SolidByColour = new Dictionary<Color, Material>();
        private static readonly HashSet<string> Missing = new HashSet<string>();

        /// <summary>
        /// A lit, opaque material of this colour (alpha is ignored, as over Quest Link).
        /// Objects of the same colour share one material, so rebuilding the ward does
        /// not leave materials behind. Do not change its colour; ask for another one.
        /// </summary>
        public static Material Solid(Color colour)
        {
            if (SolidByColour.TryGetValue(colour, out Material cached) && cached != null) return cached;

            Material template = Template(ref _solidTemplate, SolidResource);
            Material m = template != null ? new Material(template) : new Material(Shader.Find(SafeShaderName));
            m.name = $"ShiroSolid {ColorUtility.ToHtmlStringRGB(colour)}";
            m.color = colour;
            SolidByColour[colour] = m;
            return m;
        }

        /// <summary>Gives a primitive (bed, door post, marker) the solid material of this colour.</summary>
        public static void Paint(Renderer renderer, Color colour)
        {
            if (renderer != null) renderer.sharedMaterial = Solid(colour);
        }

        /// <summary>URP Unlit, for flat-coloured overlays (hand outline and fingertip rings).</summary>
        public static Shader OverlayShader
        {
            get
            {
                Material template = Template(ref _overlayTemplate, OverlayResource);
                return template != null && template.shader != null ? template.shader : Shader.Find(SafeShaderName);
            }
        }

        private static Material Template(ref Material slot, string resource)
        {
            if (slot == null && !Missing.Contains(resource))
            {
                slot = Resources.Load<Material>(resource);
                if (slot == null)
                {
                    Missing.Add(resource);
                    Debug.LogWarning($"[SHIRO MATERIALS] Assets/Resources/{resource}.mat is missing; using {SafeShaderName} instead (see SHIRO → Check APK build settings).");
                }
            }
            return slot;
        }
    }
}
