#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! 双过程睡眠/昼夜节律生物钟（`S - C`）、内生驱力、宿主抑制器、紧急唤醒旁路与非齐次泊松稀疏采样器。

use std::f64::consts::PI;

use serde::{Deserialize, Serialize};

/// 清醒期睡眠压力上升时间常数（小时）。
pub const TAU_WAKE_HOURS: f64 = 16.0;
/// 睡眠期睡眠压力衰减时间常数（小时）。
pub const TAU_SLEEP_HOURS: f64 = 4.0;
/// 入睡阈值：`sleepiness = S - C > 0.35` 时转入睡眠态。
pub const FALL_ASLEEP_THRESHOLD: f64 = 0.35;
/// 自然苏醒阈值：`sleepiness = S - C < -0.15` 时转入清醒态。
pub const NATURAL_WAKE_THRESHOLD: f64 = -0.15;

const MAX_THINNING_ITERATIONS: usize = 8192;

/// 生物钟睡眠/清醒相位。
#[derive(Copy, Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SleepPhase {
    Awake,
    Asleep,
}

/// 四维内生驱力向量（取值范围 `[0.0, 1.0]`）。
#[derive(Copy, Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EndogenousDrives {
    pub curiosity: f64,
    pub expression: f64,
    pub social: f64,
    pub commitments: f64,
}

impl EndogenousDrives {
    /// 聚合归一化驱力强度（`[0.0, 1.0]`）。
    #[must_use]
    pub fn weighted_intensity(&self) -> f64 {
        let cur = self.curiosity.clamp(0.0, 1.0);
        let exp = self.expression.clamp(0.0, 1.0);
        let soc = self.social.clamp(0.0, 1.0);
        let com = self.commitments.clamp(0.0, 1.0);
        (0.35 * com + 0.30 * cur + 0.20 * exp + 0.15 * soc).clamp(0.0, 1.0)
    }
}

impl Default for EndogenousDrives {
    fn default() -> Self {
        Self {
            curiosity: 0.5,
            expression: 0.3,
            social: 0.3,
            commitments: 0.5,
        }
    }
}

/// 宿主环境与资源抑制状态。
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostInhibitors {
    pub paused: bool,
    pub low_battery: bool,
    pub overheating: bool,
    pub budget_exhausted: bool,
}

impl HostInhibitors {
    /// 计算宿主环境对自发唤醒速率的乘数抑制因子。
    #[must_use]
    pub const fn multiplier(&self) -> f64 {
        if self.paused || self.budget_exhausted || self.overheating {
            0.0
        } else if self.low_battery {
            0.15
        } else {
            1.0
        }
    }
}

/// 唤醒信号裁决结果。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum WakeSignalResult {
    Woken {
        emergency_bypass: bool,
        sleepiness: f64,
    },
    Suppressed {
        reason: String,
        sleepiness: f64,
    },
}

fn splitmix64_next(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9e37_79b9_7f4a_7c15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^ (z >> 31)
}

/// 生成严格落在开区间 `(0.0, 1.0)` 内的双精度均匀随机数（保证 `-ln(u)` 有限且大于 0）。
fn next_open_unit_f64(state: &mut u64) -> f64 {
    let bits53 = (splitmix64_next(state) >> 11) as f64;
    let denom = (1u64 << 53) as f64;
    ((bits53 + 0.5) / denom).clamp(f64::EPSILON, 1.0 - f64::EPSILON)
}

/// 双过程生物钟与非齐次泊松下次唤醒调度器。
#[derive(Clone, Debug)]
pub struct HeartScheduler {
    sleep_pressure_s: f64,
    phase: SleepPhase,
    drives: EndogenousDrives,
    inhibitors: HostInhibitors,
    rng_state: u64,
}

impl HeartScheduler {
    #[must_use]
    pub fn new(seed: u64, initial_sleep_pressure: f64, initial_phase: SleepPhase) -> Self {
        Self {
            sleep_pressure_s: initial_sleep_pressure.clamp(0.0, 1.0),
            phase: initial_phase,
            drives: EndogenousDrives::default(),
            inhibitors: HostInhibitors::default(),
            rng_state: seed ^ 0xd1b5_4a32_d192_ed03,
        }
    }

    /// 昼夜节律过程 `C = 0.5 + 0.5 * cos(2 * pi * (local_hour - 16.0) / 24.0)`。
    #[must_use]
    pub fn circadian_process_c(local_hour: f64) -> f64 {
        let angle = 2.0 * PI * (local_hour - 16.0) / 24.0;
        (0.5 + 0.5 * angle.cos()).clamp(0.0, 1.0)
    }

    #[must_use]
    pub const fn sleep_pressure_s(&self) -> f64 {
        self.sleep_pressure_s
    }

    #[must_use]
    pub const fn phase(&self) -> SleepPhase {
        self.phase
    }

    #[must_use]
    pub const fn drives(&self) -> EndogenousDrives {
        self.drives
    }

    #[must_use]
    pub const fn inhibitors(&self) -> HostInhibitors {
        self.inhibitors
    }

    /// 当前困倦度 `sleepiness = S - C`。
    #[must_use]
    pub fn sleepiness(&self, local_hour: f64) -> f64 {
        self.sleep_pressure_s - Self::circadian_process_c(local_hour)
    }

    pub fn set_drives(&mut self, drives: EndogenousDrives) {
        self.drives = drives;
    }

    pub fn set_inhibitors(&mut self, inhibitors: HostInhibitors) {
        self.inhibitors = inhibitors;
    }

    fn update_phase_from_sleepiness(&mut self, local_hour: f64) {
        let slp = self.sleepiness(local_hour);
        match self.phase {
            SleepPhase::Awake if slp > FALL_ASLEEP_THRESHOLD => {
                self.phase = SleepPhase::Asleep;
            }
            SleepPhase::Asleep if slp < NATURAL_WAKE_THRESHOLD => {
                self.phase = SleepPhase::Awake;
            }
            SleepPhase::Awake | SleepPhase::Asleep => {}
        }
    }

    /// 推进物理经过时间并更新双过程状态机（`tau_wake = 16h` 上升，`tau_sleep = 4h` 衰减）。
    pub fn advance_hours(&mut self, delta_hours: f64, end_local_hour: f64) -> SleepPhase {
        let dt = delta_hours.max(0.0);
        match self.phase {
            SleepPhase::Awake => {
                let next_s = 1.0 - (1.0 - self.sleep_pressure_s) * (-dt / TAU_WAKE_HOURS).exp();
                self.sleep_pressure_s = next_s.clamp(0.0, 1.0);
            }
            SleepPhase::Asleep => {
                let next_s = self.sleep_pressure_s * (-dt / TAU_SLEEP_HOURS).exp();
                self.sleep_pressure_s = next_s.clamp(0.0, 1.0);
            }
        }
        self.update_phase_from_sleepiness(end_local_hour);
        self.phase
    }

    /// 记录高认知消耗任务带来的额外睡眠压力跃升。
    pub fn record_task_exertion(&mut self, exertion_bump: f64, local_hour: f64) -> SleepPhase {
        let bump = exertion_bump.max(0.0);
        self.sleep_pressure_s = (self.sleep_pressure_s + bump).clamp(0.0, 1.0);
        self.update_phase_from_sleepiness(local_hour);
        self.phase
    }

    /// 处理唤醒请求（支持长辈看护紧急告警 `bypass_sleep_inhibition = true` 强行越过睡眠与宿主抑制）。
    pub fn handle_wake_signal(
        &mut self,
        local_hour: f64,
        bypass_sleep_inhibition: bool,
    ) -> WakeSignalResult {
        let slp = self.sleepiness(local_hour);
        if bypass_sleep_inhibition {
            self.phase = SleepPhase::Awake;
            return WakeSignalResult::Woken {
                emergency_bypass: true,
                sleepiness: slp,
            };
        }

        if self.inhibitors.paused {
            return WakeSignalResult::Suppressed {
                reason: String::from("paused"),
                sleepiness: slp,
            };
        }
        if self.inhibitors.budget_exhausted {
            return WakeSignalResult::Suppressed {
                reason: String::from("budget_exhausted"),
                sleepiness: slp,
            };
        }
        if self.inhibitors.overheating {
            return WakeSignalResult::Suppressed {
                reason: String::from("overheating"),
                sleepiness: slp,
            };
        }
        if self.inhibitors.low_battery {
            return WakeSignalResult::Suppressed {
                reason: String::from("low_battery"),
                sleepiness: slp,
            };
        }

        self.update_phase_from_sleepiness(local_hour);
        if self.phase == SleepPhase::Asleep {
            return WakeSignalResult::Suppressed {
                reason: String::from("sleep_recovery"),
                sleepiness: slp,
            };
        }

        WakeSignalResult::Woken {
            emergency_bypass: false,
            sleepiness: slp,
        }
    }

    fn projected_rate_per_hour(&self, start_local_hour: f64, elapsed_hours: f64) -> f64 {
        let inh_mult = self.inhibitors.multiplier();
        if inh_mult <= 0.0 {
            return 0.0;
        }
        let drive = self.drives.weighted_intensity();
        let base_drive_rate = 0.08 + 3.92 * drive;

        let projected_s = match self.phase {
            SleepPhase::Awake => (1.0
                - (1.0 - self.sleep_pressure_s) * (-elapsed_hours / TAU_WAKE_HOURS).exp())
            .clamp(0.0, 1.0),
            SleepPhase::Asleep => {
                (self.sleep_pressure_s * (-elapsed_hours / TAU_SLEEP_HOURS).exp()).clamp(0.0, 1.0)
            }
        };
        let hour_at_t = (start_local_hour + elapsed_hours).rem_euclid(24.0);
        let c_at_t = Self::circadian_process_c(hour_at_t);
        let slp = projected_s - c_at_t;

        let is_projected_asleep = match self.phase {
            SleepPhase::Awake => slp > FALL_ASLEEP_THRESHOLD,
            SleepPhase::Asleep => slp >= NATURAL_WAKE_THRESHOLD,
        };

        let circadian_factor = if is_projected_asleep {
            0.02
        } else {
            ((1.0 - slp).clamp(0.15, 2.0)) * 0.5
        };

        inh_mult * base_drive_rate * circadian_factor
    }

    /// 基于确定性种子与 Lewis-Shedler 稀疏算法（Non-Homogeneous Poisson Thinning）采样下一次自发唤醒延迟（小时）。
    pub fn sample_next_wake_delay_hours(
        &mut self,
        start_local_hour: f64,
        horizon_hours: f64,
    ) -> Option<f64> {
        if horizon_hours <= 0.0 {
            return None;
        }
        let inh_mult = self.inhibitors.multiplier();
        if inh_mult <= 0.0 {
            return None;
        }

        let drive = self.drives.weighted_intensity();
        let lambda_upper = inh_mult * (0.08 + 3.92 * drive);
        if lambda_upper <= 0.0 {
            return None;
        }

        let mut t = 0.0;
        for _ in 0..MAX_THINNING_ITERATIONS {
            let u1 = next_open_unit_f64(&mut self.rng_state);
            let step = -u1.ln() / lambda_upper;
            t += step;
            if t > horizon_hours {
                return None;
            }

            let lambda_t = self.projected_rate_per_hour(start_local_hour, t);
            let u2 = next_open_unit_f64(&mut self.rng_state);
            if u2 * lambda_upper <= lambda_t {
                return Some(t);
            }
        }

        None
    }
}
