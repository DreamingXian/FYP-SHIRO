// =============================================================================
// Project SHIRO - Meta Quest 3 Mixed Reality Client
// Data Models matching SHIRO Hospital Edge Server Schema
// =============================================================================
using System;
using System.Collections.Generic;
using UnityEngine;

namespace ShiroMR
{
    [Serializable]
    public class WardInitResponse
    {
        public bool success;
        public WardConfig ward;
        public List<TrackedSubject> tracked_subjects;
        public CalibrationInfo calibration;
        public string error;
    }

    [Serializable]
    public class WardSummary
    {
        public string ward_id;
        public string room_title;
        public float length_x;
        public float width_y;
        public float height_z;
        public string spatial_anchor_uuid;
        public string layout_type;
    }

    [Serializable]
    public class WardListResponse
    {
        public bool success;
        public List<WardSummary> wards;
        public string error;
    }

    [Serializable]
    public class WardConfig
    {
        public string ward_id;
        public string room_title;
        public float length_x;
        public float width_y;
        public float height_z;
        public float width => length_x > 0 ? length_x : 5.0f;
        public float length => width_y > 0 ? width_y : 6.0f;
        public WardDoor door;
        public string spatial_anchor_uuid;
        public string layout_type;
        public List<WardObstacle> obstacles;
        public List<WardBed> beds;
        public List<WardAnchor> anchors;
    }

    [Serializable]
    public class WardDoor
    {
        public string wall;
        public float x;
        public float y;
        public float width;
    }

    [Serializable]
    public class WardObstacle
    {
        public string id;
        public string type;
        public string label;
        public float x;
        public float y;
        public float width;
        public float length;
        public float height;
    }

    [Serializable]
    public class WardBed
    {
        public string bed_id;
        public string bed_code;
        public float x;
        public float y;
        public float width;
        public float length;
        public int rotation_deg;
        public string status;
    }

    [Serializable]
    public class WardAnchor
    {
        public string anchor_id;
        public string device_id;
        public string mac_address;
        public float x;
        public float y;
        public float z;
        public string wall_location;
        public string status;
        public float? calibrated_a;
        public float? calibrated_n;
    }

    [Serializable]
    public class TrackedSubject
    {
        public string binding_id;
        public string patient_id;
        public string full_name;
        public string nric_passport;
        public string gender;
        public string dob;
        public string assigned_bed_id;
        public string assigned_ward_id;
        public bool is_ward_resident;
        public string medical_history;
        public string photo_url;
        public string patient_status;
        public string device_id; // Tag ID (e.g. TAG-001)
        public string mac_address;
        public string device_status;
        public int battery_level;
        public string firmware_version;
    }

    [Serializable]
    public class CalibrationInfo
    {
        public float A;
        public float n;
    }

    [Serializable]
    public class WsMessageBase
    {
        public string type;
    }

    [Serializable]
    public class IpsPositionUpdate : WsMessageBase
    {
        public string tag_id;
        public string canonical_id;
        public string tag_mac;
        public float x;
        public float y;
        public string ward_id;
        public string status;
        public string motion_state; // STATIONARY, HAND_MOVEMENT, WALKING, SETTLING
        public float confidence;
        public long timestamp;
    }

    [Serializable]
    public class TelemetryData
    {
        public string tag_id;
        public string tag_mac;
        public int bpm;
        public int spo2;
        public float g;
        public string motion;
        public int touch;
        public bool active;
        public int battery;
        public bool charging;
        public string detected_by_anchor;
    }

    [Serializable]
    public class TelemetryUpdate : WsMessageBase
    {
        public string topic;
        public TelemetryData data;
        // Flat fallbacks if publisher sends flat JSON
        public string tag_id;
        public int bpm;
        public int spo2;
        public int battery;
        public string motion;
        public string timestamp;

        public string EffectiveTagId => !string.IsNullOrEmpty(data?.tag_id) ? data.tag_id : tag_id;
        public int EffectiveBpm => (data != null && data.bpm > 0) ? data.bpm : bpm;
        public int EffectiveSpo2 => (data != null && data.spo2 > 0) ? data.spo2 : spo2;
        public int EffectiveBattery => (data != null && data.battery >= 0) ? data.battery : battery;
        public string EffectiveMotion => !string.IsNullOrEmpty(data?.motion) ? data.motion : motion;
    }

    [Serializable]
    public class TagPurgeUpdate : WsMessageBase
    {
        public string tag_id;
        public string canonical_id;
        public string mac;
    }
}

