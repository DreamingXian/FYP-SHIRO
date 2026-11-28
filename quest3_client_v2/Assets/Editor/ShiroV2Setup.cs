// =============================================================================
// Project SHIRO - headset app version 2: one-time project setup
//
// SHIRO → v2: Import TextMeshPro essentials. The new interface draws its text
// with TextMeshPro (sharp at any distance, unlike the old UI Text); TextMeshPro
// needs its essential resources (default font, shaders, settings) in Assets.
// Also run from the command line in batch mode:
//   Unity.exe -batchmode -nographics -quit -projectPath <quest3_client_v2>
//     -executeMethod ShiroMR.EditorTools.ShiroV2Setup.ImportTmpEssentials
// =============================================================================
using System.IO;
using UnityEditor;
using UnityEngine;

namespace ShiroMR.EditorTools
{
    public static class ShiroV2Setup
    {
        private const string TmpFolder = "Assets/TextMesh Pro";

        [MenuItem("SHIRO/v2: Import TextMeshPro essentials")]
        public static void ImportTmpEssentials()
        {
            if (AssetDatabase.IsValidFolder(TmpFolder))
            {
                Debug.Log("[SHIRO v2] TextMeshPro essentials are already in Assets/TextMesh Pro.");
                return;
            }
            var ugui = UnityEditor.PackageManager.PackageInfo.FindForAssetPath("Packages/com.unity.ugui");
            if (ugui == null)
            {
                Debug.LogError("[SHIRO v2] The com.unity.ugui package was not found: TextMeshPro essentials not imported.");
                return;
            }
            string package = Path.Combine(ugui.resolvedPath, "Package Resources", "TMP Essential Resources.unitypackage");
            if (!File.Exists(package))
            {
                Debug.LogError($"[SHIRO v2] Not found: {package}");
                return;
            }
            AssetDatabase.ImportPackage(package, false);
            AssetDatabase.Refresh();
            Debug.Log($"[SHIRO v2] TextMeshPro essentials imported from {package}.");
        }
    }
}
