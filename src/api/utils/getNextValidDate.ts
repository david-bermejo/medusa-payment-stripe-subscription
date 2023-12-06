import { isSameWeek, isWeekend, nextMonday } from "date-fns"

export function getNextValidDate(date: Date, lastCollectionDate?: Date): Date {
    if (lastCollectionDate && isSameWeek(date, lastCollectionDate))
        return nextMonday(lastCollectionDate)

    const tomorrow = new Date(date)
    const daysToAdd = isWeekend(date) ? (7-date.getDay())%7+1 : 1
    tomorrow.setDate(tomorrow.getDate()+daysToAdd)
    return tomorrow
}