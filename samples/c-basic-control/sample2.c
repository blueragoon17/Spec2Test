#include <limits.h>
#include <stddef.h>

typedef enum Mode {
    MODE_LOCKED = 0,
    MODE_UNLOCKED = 1,
    MODE_ALARM = 2
} Mode;

typedef enum Event {
    EVENT_NONE = 0,
    EVENT_CORRECT_PIN = 1,
    EVENT_WRONG_PIN = 2,
    EVENT_RESET = 3,
    EVENT_TIMEOUT = 4
} Event;

int safe_divide(int a, int b, int *out)
{
    if (out == NULL) {
        return -2;
    }
    if (b == 0) {
        *out = 0;
        return -1;
    }
    if (a == INT_MIN && b == -1) {
        *out = 0;
        return -3;
    }
    *out = a / b;
    return 0;
}

int clamp_percent(int value)
{
    if (value < 0) {
        return 0;
    }
    if (value > 100) {
        return 100;
    }
    return value;
}

Mode update_mode(Mode current, Event event, int retry_count)
{
    if (event == EVENT_RESET) {
        return MODE_LOCKED;
    }
    if (current == MODE_ALARM) {
        return event == EVENT_TIMEOUT ? MODE_LOCKED : MODE_ALARM;
    }
    if (current == MODE_LOCKED) {
        if (event == EVENT_CORRECT_PIN) {
            return MODE_UNLOCKED;
        }
        if (event == EVENT_WRONG_PIN && retry_count >= 3) {
            return MODE_ALARM;
        }
        return MODE_LOCKED;
    }
    if (current == MODE_UNLOCKED) {
        return event == EVENT_TIMEOUT ? MODE_LOCKED : MODE_UNLOCKED;
    }
    return MODE_ALARM;
}
