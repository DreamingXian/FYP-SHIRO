// =============================================================================
// Project SHIRO - Unity editor menu: SHIRO → Apply / Check APK build settings
//
// Sets what the headset app needs to run on its own (APK, phase 9D), the same way
// for every build: name, package, version, Android settings, and the network
// security file that lets the app reach the edge server over plain HTTP on the
// ward network (Assets/Oculus/ShiroNetworkSecurityConfig.xml).
// Quest Link testing in the editor is not affected by any of these.
// =============================================================================
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEditor.Build;
using UnityEngine;

namespace ShiroMR.EditorTools
{
    public static class ShiroApkSettings
    {
        public const string CompanyName = "SHIRO";
        public const string ProductName = "SHIRO MR";
        public const string PackageName = "com.shiro.mrpatientconnect";
        public const string Version = "1.1.0";
        public const int VersionCode = 1;
        public const string NetworkSecurityFile = "Assets/Oculus/ShiroNetworkSecurityConfig.xml";

        [MenuItem("SHIRO/Apply APK build settings", priority = 1)]
        public static void Apply()
        {
            PlayerSettings.companyName = CompanyName;
            PlayerSettings.productName = ProductName;
            PlayerSettings.bundleVersion = Version;
            PlayerSettings.SetApplicationIdentifier(NamedBuildTarget.Android, PackageName);
            PlayerSettings.Android.bundleVersionCode = VersionCode;
            PlayerSettings.SetScriptingBackend(NamedBuildTarget.Android, ScriptingImplementation.IL2CPP);
            PlayerSettings.Android.targetArchitectures = AndroidArchitecture.ARM64;
            PlayerSettings.Android.forceInternetPermission = true;
            PlayerSettings.insecureHttpOption = InsecureHttpOption.AlwaysAllowed;

            var config = OVRProjectConfig.CachedProjectConfig;
            if (config == null)
            {
                Debug.LogError("[SHIRO APK] The Meta XR project config is not loaded yet. Wait until the editor has finished loading, then run the menu again.");
                return;
            }
            config.enableNSCConfig = true;
            config.securityXmlPath = NetworkSecurityFile;
            OVRProjectConfig.CommitProjectConfig(config);

            AssetDatabase.SaveAssets();
            Debug.Log("[SHIRO APK] Build settings applied. Save the project (File → Save Project) so they are written to disk.");
            Check();
        }

        [MenuItem("SHIRO/Check APK build settings", priority = 2)]
        public static bool Check()
        {
            var problems = new List<string>();
            void Expect(bool ok, string what) { if (!ok) problems.Add(what); }

            Expect(EditorUserBuildSettings.activeBuildTarget == BuildTarget.Android, "the build platform is not Android (File → Build Profiles → Android → Switch Platform)");
            Expect(PlayerSettings.productName == ProductName, $"product name is \"{PlayerSettings.productName}\", expected \"{ProductName}\"");
            Expect(PlayerSettings.GetApplicationIdentifier(NamedBuildTarget.Android) == PackageName, $"package name is {PlayerSettings.GetApplicationIdentifier(NamedBuildTarget.Android)}, expected {PackageName}");
            Expect(PlayerSettings.bundleVersion == Version, $"version is {PlayerSettings.bundleVersion}, expected {Version}");
            Expect(PlayerSettings.GetScriptingBackend(NamedBuildTarget.Android) == ScriptingImplementation.IL2CPP, "the scripting backend is not IL2CPP (Quest needs 64-bit ARM)");
            Expect(PlayerSettings.Android.targetArchitectures == AndroidArchitecture.ARM64, "the target architecture is not ARM64 only");
            Expect(PlayerSettings.Android.forceInternetPermission, "Internet access is not set to Require");
            Expect(PlayerSettings.insecureHttpOption == InsecureHttpOption.AlwaysAllowed, "plain HTTP is not allowed (Player → Other Settings → Allow downloads over HTTP)");

            var config = OVRProjectConfig.CachedProjectConfig;
            Expect(config != null, "the Meta XR project config is not loaded");
            if (config != null)
            {
                Expect(config.enableNSCConfig && config.securityXmlPath == NetworkSecurityFile,
                    $"the network security file is not {NetworkSecurityFile}: Meta's default blocks plain HTTP, the app could not reach the edge server");
                Expect(config.sceneSupport != OVRProjectConfig.FeatureSupport.None, "Scene support is off: the spatial data permission would be missing from the app");
                Expect(config.anchorSupport == OVRProjectConfig.AnchorSupport.Enabled, "spatial anchor support is off: ward alignment could not be saved");
            }
            Expect(File.Exists(NetworkSecurityFile), $"{NetworkSecurityFile} is missing");

            if (problems.Count == 0)
            {
                Debug.Log($"[SHIRO APK] Ready to build: {ProductName} {Version} ({PackageName}), IL2CPP ARM64, plain HTTP to the edge server allowed.");
                return true;
            }
            Debug.LogWarning("[SHIRO APK] Not ready to build:\n- " + string.Join("\n- ", problems) + "\nRun SHIRO → Apply APK build settings.");
            return false;
        }
    }
}
