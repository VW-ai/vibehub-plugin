#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Size {
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WorkArea {
    pub origin: Point,
    pub size: Size,
}

pub fn corner_origin(work_area: WorkArea, window: Size, margin: u32) -> Point {
    let desired = Point {
        x: saturating_i32(
            i64::from(work_area.origin.x) + i64::from(work_area.size.width)
                - i64::from(window.width)
                - i64::from(margin),
        ),
        y: saturating_i32(
            i64::from(work_area.origin.y) + i64::from(work_area.size.height)
                - i64::from(window.height)
                - i64::from(margin),
        ),
    };
    clamp_window_origin(work_area, window, desired, margin)
}

pub fn clamp_logical_height(
    requested: f64,
    minimum: f64,
    physical_work_height: u32,
    scale_factor: f64,
) -> f64 {
    if !scale_factor.is_finite() || scale_factor <= 0.0 {
        return requested.max(minimum);
    }
    let available = f64::from(physical_work_height) / scale_factor;
    if !available.is_finite() || available <= 0.0 {
        return requested.max(minimum);
    }
    requested.min(available).max(minimum.min(available))
}

pub fn clamp_window_origin(
    work_area: WorkArea,
    window: Size,
    desired: Point,
    margin: u32,
) -> Point {
    Point {
        x: clamp_axis(
            work_area.origin.x,
            work_area.size.width,
            window.width,
            desired.x,
            margin,
        ),
        y: clamp_axis(
            work_area.origin.y,
            work_area.size.height,
            window.height,
            desired.y,
            margin,
        ),
    }
}

fn clamp_axis(origin: i32, available: u32, extent: u32, desired: i32, margin: u32) -> i32 {
    let lower = i64::from(origin) + i64::from(margin.min(available));
    let upper = i64::from(origin) + i64::from(available)
        - i64::from(extent)
        - i64::from(margin.min(available));
    if upper < lower {
        return saturating_i32(i64::from(origin) + (i64::from(available) - i64::from(extent)) / 2);
    }
    saturating_i32(i64::from(desired).clamp(lower, upper))
}

fn saturating_i32(value: i64) -> i32 {
    value.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    const WINDOW: Size = Size {
        width: 360,
        height: 152,
    };

    #[test]
    fn places_the_corner_inside_a_positive_work_area() {
        let area = WorkArea {
            origin: Point { x: 0, y: 25 },
            size: Size {
                width: 1440,
                height: 875,
            },
        };
        assert_eq!(corner_origin(area, WINDOW, 16), Point { x: 1064, y: 732 });
    }

    #[test]
    fn clamps_to_negative_coordinate_displays() {
        let area = WorkArea {
            origin: Point { x: -1920, y: -200 },
            size: Size {
                width: 1920,
                height: 1080,
            },
        };
        assert_eq!(
            clamp_window_origin(area, WINDOW, Point { x: -10, y: 900 }, 12),
            Point { x: -372, y: 716 }
        );
    }

    #[test]
    fn centers_an_oversized_window_without_overflowing_integers() {
        let area = WorkArea {
            origin: Point {
                x: i32::MAX - 100,
                y: i32::MIN + 100,
            },
            size: Size {
                width: 80,
                height: 60,
            },
        };
        assert_eq!(
            clamp_window_origin(
                area,
                Size {
                    width: 120,
                    height: 100,
                },
                Point { x: 0, y: 0 },
                12,
            ),
            Point {
                x: i32::MAX - 120,
                y: i32::MIN + 80,
            }
        );
    }

    #[test]
    fn clamps_expanded_logical_height_to_scaled_current_work_area() {
        assert_eq!(clamp_logical_height(620.0, 126.0, 1_000, 2.0), 500.0);
        assert_eq!(clamp_logical_height(620.0, 126.0, 900, 1.0), 620.0);
        assert_eq!(clamp_logical_height(620.0, 126.0, 100, 1.0), 100.0);
    }
}
