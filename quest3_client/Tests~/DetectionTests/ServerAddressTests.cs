// Automated tests of the edge server address typed on the hand slate (ShiroServerAddress.cs).
using System;
using ShiroMR.Net;

internal static class ServerAddressTests
{
    public static void RunAll(Action<string, Action> run)
    {
        run("server address: ordinary LAN addresses are accepted", Accepted);
        run("server address: three numbers, a number above 255, an empty part or a 0 in front are refused", Refused);
        run("server address: no computer: 0.x, group and broadcast addresses, 169.254.x.x (no network)", NotAComputer);
        run("server address keypad: no dot first, no two dots, at most three dots and three digits per number", KeypadRules);
        run("server address keypad: backspace and clear", KeypadEditing);
        run("server address: 127.x is the device the app runs on", ThisDevice);
    }

    private static void Accepted()
    {
        foreach (string a in new[] { "192.168.1.229", "192.168.137.1", "10.0.0.5", "172.16.4.20", "127.0.0.1", " 192.168.1.20 " })
            Equal(null, ServerAddress.Problem(a), a);
    }

    private static void Refused()
    {
        foreach (string a in new[] { "", "   ", null, "192.168.1", "192.168.1.2.3", "192.168.1.256", "192.168..1", "192.168.1.", "192.168.01.20", "192.168.1.2a", "1921.168.1.2" })
            True(ServerAddress.Problem(a) != null, $"'{a}' refused");
        True(ServerAddress.Problem("192.168.1.256").Contains("256"), "names the number that is too large");
        True(ServerAddress.Problem("192.168.01.20").Contains("Write 1"), "says how to write it");
    }

    private static void NotAComputer()
    {
        foreach (string a in new[] { "0.0.0.0", "224.0.0.1", "239.1.2.3", "255.255.255.255" })
            True(ServerAddress.Problem(a) != null, $"'{a}' refused");
        True(ServerAddress.Problem("169.254.10.2").Contains("no network"), "169.254 explained");
    }

    private static string Type(params string[] keys)
    {
        string typed = "";
        foreach (string k in keys) typed = ServerAddress.Press(typed, k);
        return typed;
    }

    private static void KeypadRules()
    {
        Equal("", Type("."), "no dot first");
        Equal("19.", Type("1", "9", ".", "."), "no two dots");
        Equal("1.2.3.4", Type("1", ".", "2", ".", "3", ".", "4", "."), "no fourth dot");
        Equal("192.168", Type("1", "9", "2", "5", ".", "1", "6", "8", "0"), "three digits per number");
        Equal("255.255.255.255", Type("2", "5", "5", ".", "2", "5", "5", ".", "2", "5", "5", ".", "2", "5", "5", "9"), "fifteen characters at most");
        Equal("12", Type("1", "x", "2", null, "", "34"), "other keys ignored");
    }

    private static void KeypadEditing()
    {
        Equal("192.16", Type("1", "9", "2", ".", "1", "6", "8", ServerAddress.Backspace), "backspace");
        Equal("", Type(ServerAddress.Backspace), "backspace on nothing");
        Equal("", Type("1", "9", ServerAddress.Clear), "clear");
        Equal("192.17", Type("1", "9", "2", ".", "1", "6", ServerAddress.Backspace, "7"), "typing again after backspace");
    }

    private static void ThisDevice()
    {
        True(ServerAddress.IsThisDevice("127.0.0.1"), "127.0.0.1");
        True(!ServerAddress.IsThisDevice("192.168.1.229"), "LAN address");
        True(!ServerAddress.IsThisDevice(null), "nothing");
    }

    private static void Equal<T>(T expected, T actual, string what)
    {
        if (!Equals(expected, actual))
            throw new Exception($"{what}: expected '{expected}', got '{actual}'");
    }

    private static void True(bool cond, string what)
    {
        if (!cond) throw new Exception($"{what}: not true");
    }
}
