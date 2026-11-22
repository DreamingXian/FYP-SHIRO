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
        // Optional body measurements. The server sends null when not recorded,
        // which JsonUtility reads as 0: 0 means "not recorded", never a real value.
        public int height_cm;
        public float weight_kg;
        public bool HasHeight => height_cm > 0;
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
        // Where x, y come from: "HEADSET" (a headset's depth sensor sees the patient, while it
        // is linked to the wristband) or "BLE" (Bluetooth). Missing from an older edge server.
        public string source;
        public string seen_by;      // the headset that sees the patient
        public bool has_ble;        // ble_x / ble_y are known
        public float ble_x, ble_y;  // the Bluetooth position, always

        public bool lidar_held;     // LIDAR: not seen just now, where the LiDAR last saw them
        public bool lidar_in_bed;   // LIDAR: held in their bed

        public bool FromHeadset => source == "HEADSET";

        /// <summary>
        /// Version 2: the best position for this headset's panel, in the edge server's order:
        /// a person seen by another headset's depth sensor ("HEADSET"), else the LiDAR
        /// ("LIDAR", about ±0.1 m), else Bluetooth ("BLE"). This headset's own depth position
        /// is not taken back (it would always confirm its own link, see TryGetBle): the panel
        /// follows its linked person itself, and its decisions use the next best source.
        /// </summary>
        public bool TryGetBest(string ownHeadsetId, out float px, out float py, out string from)
        {
            if (source == "LIDAR") { px = x; py = y; from = "LIDAR"; return true; }
            if (source == "HEADSET" && !string.IsNullOrEmpty(seen_by) &&
                !string.Equals(seen_by, ownHeadsetId, StringComparison.OrdinalIgnoreCase))
            {
                px = x; py = y; from = "HEADSET";
                return true;
            }
            from = "BLE";
            return TryGetBle(out px, out py);
        }

        /// <summary>The Bluetooth position (for the panel's own decisions: bed rule, linking).
        /// False when only a headset's position is known.</summary>
        public bool TryGetBle(out float x, out float y)
        {
            if (string.IsNullOrEmpty(source)) { x = this.x; y = this.y; return true; } // older server: x, y are Bluetooth
            x = ble_x; y = ble_y;
            return has_ble;
        }
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

    /// <summary>
    /// An incident from the edge server (fall, critical vitals, geofence): the
    /// EMERGENCY_ALERT broadcast and the rows of /api/alerts/active.
    /// A value the server sends as null is 0 here: 0 is shown as "not measured".
    /// </summary>
    [Serializable]
    public class IncidentAlert
    {
        public string incident_id;
        public string patient_id;
        public string patient_name;
        public string ward_id;
        public string bed_id;
        public string wristband_mac;
        public string device_id;
        public string incident_category; // FALL_ACCIDENT, CRITICAL_VITALS, GEOFENCE_BREACH
        public string geofence_kind;     // GEOFENCE_BREACH only: LEFT_WARD or AT_DOOR (null for older alerts)
        public string trigger_timestamp;
        public float pos_x;
        public float pos_y;
        public float kinematic_impact_force;
        public float post_impact_stillness;
        public float freefall_min_g;
        public int heart_rate;
        public float spo2;
        public string alert_message;
        public string resolution_status;
        public string attending_clinician;

        // is_simulated is true/false in the broadcast and 0/1 in database rows; the
        // server always starts the message of a test alarm with "[SIMULATION]".
        public bool IsSimulated => !string.IsNullOrEmpty(alert_message) && alert_message.StartsWith("[SIMULATION]");

        public string CategoryLabel =>
            incident_category == "FALL_ACCIDENT" ? "FALL" :
            incident_category == "CRITICAL_VITALS" ? "CRITICAL VITALS" :
            incident_category == "GEOFENCE_BREACH" ? (geofence_kind == "AT_DOOR" ? "AT THE DOOR" : "LEFT THE WARD") :
            (incident_category ?? "INCIDENT");
    }

    [Serializable]
    public class EmergencyAlertMessage : WsMessageBase
    {
        public IncidentAlert incident;
    }

    [Serializable]
    public class EmergencyAcknowledgedMessage : WsMessageBase
    {
        public string incident_id;
        public string attending_clinician;
        public string timestamp;
    }

    [Serializable]
    public class ActiveAlertsResponse
    {
        public bool success;
        public List<IncidentAlert> alerts;
        public string error;
    }

    /// <summary>A clinician as the server names one: { id, name }. Empty id = nobody.</summary>
    [Serializable]
    public class ClinicianRef
    {
        public string id;
        public string name;
        public bool IsSet => !string.IsNullOrEmpty(id);
    }

    [Serializable]
    public class HeadsetAssignmentMessage : WsMessageBase
    {
        public string device_id;
        public ClinicianRef assigned_clinician;
    }

    [Serializable]
    public class AuthMeUser
    {
        public string type;
        public string device_id;
        public string paired_by;
        public ClinicianRef assigned_clinician;
    }

    [Serializable]
    public class AuthMeResponse
    {
        public bool success;
        public AuthMeUser user;
    }

    /// <summary>The edge server sent the 1 Hz command for a wristband (ACTIVE_MODE_ENGAGED).</summary>
    [Serializable]
    public class ActiveModeEngagedMessage : WsMessageBase
    {
        public string tag_id;
        public string via_anchor;
        public string anchor_mac;
        public int duration;
    }

    /// <summary>A refused command (type ERROR): which action and why.</summary>
    [Serializable]
    public class CommandErrorMessage : WsMessageBase
    {
        public string action;
        public string error;
    }

    [Serializable]
    public class AcknowledgeResponse
    {
        public bool success;
        public string incident_id;
        public string attending_clinician;
        public string error;
    }
}

